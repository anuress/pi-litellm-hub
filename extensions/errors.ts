import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redact } from "./redact.ts";
import { formatResetDate, publishFailure, updateStatus, type HubState } from "./status.ts";

const MAX_REASON_LENGTH = 120;
const MAX_ERROR_TEXT_LENGTH = 4_000;
const ERROR_REASON_PREFIX = "failed: ";
const STREAM_ERROR_PREFIX = "failed: gateway error inside a 200 response: ";
const KEY_HASH_PATTERN = /(\b(?:api[_ -]?)?key[_ -]?hash\b\s*(?:(?:["']?\s*[:=]\s*["']?)|is\s+|\s+))([A-Za-z0-9_-]+)/gi;
const CURRENT_SPEND_PATTERN = /\bcurrent\s+(?:cost|spend(?:\s+for\s+token)?)\s*[:=]\s*\$?([\d][\d,]*(?:\.\d+)?)/i;
const MAX_BUDGET_PATTERN = /\bmax(?:imum)?\s+budget(?:\s+for\s+token)?\s*[:=]\s*\$?([\d][\d,]*(?:\.\d+)?)/i;

type FailureState = Pick<HubState, "keySpend" | "keyBudget" | "resetAt">;

type FailureInput = {
  status?: number;
  errorMessage?: string;
  body?: string;
  state?: FailureState;
};

export type ErrorsDependencies = { apiKey: string };

export function isRouteRestriction(status: number | undefined, text: string): boolean {
  return status === 403 && /\bnot allowed to call this route\b/i.test(text);
}

export function isCloudflareBlock(status: number | undefined, text: string): boolean {
  return /\berror\s+1010\b|\berror\s+code\s*:\s*1010\b/i.test(text) ||
    (status === 403 && /\baccess denied\b/i.test(text));
}

function truncate(text: string, limit: number): string {
  const safeLimit = Number.isNaN(limit)
    ? MAX_REASON_LENGTH
    : Math.max(0, Math.min(MAX_REASON_LENGTH, Math.trunc(limit)));
  if (text.length <= safeLimit) return text;
  if (safeLimit <= 0) return "";
  if (safeLimit === 1) return "…";

  // Count UTF-16 units for the cap while iterating whole code points to avoid split surrogate pairs.
  const contentLimit = safeLimit - 1;
  let content = "";
  for (const character of text) {
    if (content.length + character.length > contentLimit) break;
    content += character;
  }
  return `${content.trimEnd()}…`;
}

function redactKeyHashes(text: string): string {
  // LiteLLM's parallel-limit text can include a key hash; never surface that identifier.
  return text.replace(KEY_HASH_PATTERN, (_match, label: string) => `${label}[redacted]`);
}

function stripErrorPrefix(text: string): string {
  // Pi-ai's SDK adapters format HTTP failures as either `400: ...`, `400 ...`, or `provider API error (400): ...`.
  return text
    .replace(/^\s*[^\r\n]*?\bAPI(?:\s+error)?\s*\(\s*\d{3}\s*\)\s*:\s*/i, "")
    .replace(/^\s*(?:HTTP(?:\s+error)?\s+)?\d{3}(?:\s+status code(?:\s*\(no body\))?)?(?::\s*|\s+|$)/i, "")
    .replace(/^(?:\s*Error Code\s+[A-Za-z0-9_-]+\s*:\s*)+/i, "");
}

function messageFromJson(candidate: string): string | undefined {
  try {
    const value: unknown = JSON.parse(candidate);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const error = record.error;
    let hasMessage = false;
    if (typeof error === "object" && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") {
        hasMessage = true;
        if (message.trim()) return message;
      }
    }
    const message = record.message;
    if (typeof message === "string") {
      hasMessage = true;
      if (message.trim()) return message;
    }
    return hasMessage ? "" : undefined;
  } catch {
    // SDK error messages may put a status prefix or other text before the JSON body.
    return undefined;
  }
}

function jsonMessage(text: string): string | undefined {
  const trimmed = text.slice(0, MAX_ERROR_TEXT_LENGTH).trim();
  if (trimmed.length <= MAX_ERROR_TEXT_LENGTH) {
    const directMessage = messageFromJson(trimmed);
    if (directMessage !== undefined) return directMessage;
  }

  // Try balanced objects from left to right. Each candidate has its own string/escape state,
  // so malformed prefix text cannot hide a later SDK JSON body. Outer valid objects win first.
  const scanLength = trimmed.length;
  for (let start = 0; start < scanLength; start++) {
    if (trimmed[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < scanLength; end++) {
      const character = trimmed[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth++;
      } else if (character === "}" && --depth === 0) {
        const message = messageFromJson(trimmed.slice(start, end + 1));
        if (message !== undefined) return message;
        break;
      }
    }
  }
  return undefined;
}

export function shortMessage(text: string, maxLength = MAX_REASON_LENGTH): string {
  // Pi-ai bounds normalized HTTP error bodies at 4,000 characters; also cap appended metadata here.
  const boundedText = text.slice(0, MAX_ERROR_TEXT_LENGTH);
  // Use the API's message field when present, then strip markup and collapse it for a one-line status.
  const message = stripErrorPrefix(jsonMessage(boundedText) ?? boundedText);
  const plain = message
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(redactKeyHashes(redact(plain)) || "unknown error", maxLength);
}

function failureText(input: FailureInput): string {
  return [input.errorMessage, input.body]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => part.slice(0, MAX_ERROR_TEXT_LENGTH))
    .join("\n")
    .slice(0, MAX_ERROR_TEXT_LENGTH);
}

function statusFromErrorMessage(text?: string): number | undefined {
  if (!text) return undefined;
  const boundedText = text.slice(0, MAX_ERROR_TEXT_LENGTH);
  const apiError = boundedText.match(/^\s*[^\r\n]*?\bAPI(?:\s+error)?\s*\(\s*(\d{3})\s*\)\s*:/i);
  const leadingStatus = boundedText.match(/^\s*(?:HTTP(?:\s+error)?\s+)?(\d{3})(?=\s|:|$)/i);
  const match = apiError ?? leadingStatus;
  return match ? Number(match[1]) : undefined;
}

function stateAmount(value: number | undefined, digits: number): string | undefined {
  return value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : undefined;
}

function litellmModelKey(ctx: { model?: { provider?: string; api?: string; id?: string } }): string | undefined {
  const model = ctx.model;
  if (model?.provider !== "litellm") return undefined;
  return JSON.stringify([model.provider, model.api ?? "", model.id ?? ""]);
}

function budgetAmount(value: string): string {
  // Wire amounts contain only digits and numeric separators; retain up to 20 useful characters.
  return value.length <= 20 ? value : `${value.slice(0, 20)}…`;
}

function budgetReason(text: string, state?: FailureState): string {
  const spendInMessage = text.match(CURRENT_SPEND_PATTERN)?.[1];
  const budgetInMessage = text.match(MAX_BUDGET_PATTERN)?.[1];
  const spend = spendInMessage ?? stateAmount(state?.keySpend, 2) ?? "?";
  const budget = budgetInMessage ?? stateAmount(state?.keyBudget, 0) ?? "?";
  const resetDate = state?.resetAt ? formatResetDate(state.resetAt) : undefined;
  const reset = resetDate ? `, resets ${resetDate}` : "";
  return `failed: out of budget ($${budgetAmount(spend)}/$${budgetAmount(budget)}${reset})`;
}

function routePermissionReason(text: string): string {
  const route = text.match(/\btried to call route:\s*(\/[^\s"'<>]+)/i)?.[1];
  return `failed: key not allowed to call ${route ? truncate(route, 65) : "this route"}; ask the gateway admin`;
}

export function classifyFailure(input: FailureInput): string | undefined {
  const text = failureText(input);
  // Prefer an explicit HTTP status in the SDK's error string over a possibly stale 200 stream callback.
  const status = statusFromErrorMessage(input.errorMessage) ?? statusFromErrorMessage(input.body) ?? input.status;

  // Budget and parallel-limit reasons are fixed strings so gateway details and key hashes never leak.
  if (/\bbudget_exceeded\b|\bexceededtokenbudget\b|\bbudget\s+(?:has\s+been\s+)?exceeded\b/i.test(text)) {
    return budgetReason(text, input.state);
  }
  if (/max_parallel_requests|max parallel request limit reached/i.test(text)) {
    return "failed: gateway busy (parallel request limit)";
  }
  if (isRouteRestriction(status, text)) return routePermissionReason(text);
  if (isCloudflareBlock(status, text)) {
    return "failed: blocked by Cloudflare (1010), not a key problem";
  }
  if (status === 200) {
    return `${STREAM_ERROR_PREFIX}${shortMessage(input.errorMessage || input.body || "", MAX_REASON_LENGTH - STREAM_ERROR_PREFIX.length)}`;
  }
  return undefined;
}

export function registerErrors(
  pi: ExtensionAPI,
  state: HubState,
  deps: ErrorsDependencies,
): void {
  const responseStatuses = new Map<string, number>();
  let ownedReason: string | undefined;

  // Cache warming can replay the response hook without a matching message_end, so reset at each request boundary.
  pi.on("before_provider_headers", (_event, ctx) => {
    const key = litellmModelKey(ctx);
    if (key !== undefined) responseStatuses.delete(key);
  });

  // pi-ai calls onResponse before consuming a successful HTTP stream, so this captures HTTP 200 stream errors.
  pi.on("after_provider_response", (event, ctx) => {
    const key = litellmModelKey(ctx);
    if (key !== undefined) responseStatuses.set(key, event.status);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (
      message.role !== "assistant" ||
      message.provider !== "litellm" ||
      ctx.model?.provider !== "litellm"
    ) {
      return;
    }

    // Pending and aborted replies have no terminal request boundary; retain status for a final message.
    if (message.stopReason === "pending" || message.stopReason === "aborted") return;

    // Consume the response status keyed to this model so independent models can interleave safely.
    // Pi's events expose no request ID, so simultaneous requests for the same model remain ambiguous.
    const key = litellmModelKey(ctx);
    const responseStatusForMessage = key === undefined ? undefined : responseStatuses.get(key);
    if (key !== undefined) responseStatuses.delete(key);
    const status = statusFromErrorMessage(message.errorMessage) ?? responseStatusForMessage;

    if (message.stopReason === "error") {
      const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
      const classified = classifyFailure({
        status,
        errorMessage,
        state,
      });
      const rawReason = classified ?? `${ERROR_REASON_PREFIX}${shortMessage(
        errorMessage || "unknown error",
        MAX_REASON_LENGTH - ERROR_REASON_PREFIX.length,
      )}`;
      const reason = redact(redactKeyHashes(rawReason), deps.apiKey);
      state.reason = reason;
      ownedReason = reason;
      publishFailure(state, message.model, reason);
      updateStatus(ctx, state, deps.apiKey);
      return;
    }

    if (ownedReason === undefined) return;

    const shouldClear = state.reason === ownedReason;
    ownedReason = undefined;
    if (shouldClear) {
      state.reason = undefined;
      updateStatus(ctx, state, deps.apiKey);
    }
  });
}
