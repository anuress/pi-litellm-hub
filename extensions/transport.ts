import packageInfo from "../package.json" with { type: "json" };
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HubState } from "./status.ts";
import { updateStatus } from "./status.ts";

export const USER_AGENT = `pi-litellm-hub/${packageInfo.version}`;
const SESSION_HEADER = "x-litellm-session-id";

export type TransportDependencies = {
  getSessionId?: (ctx: ExtensionContext) => string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays and primitives cannot carry the named request fields this helper reads.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeHeader(headers: Record<string, string | null>, name: string): void {
  // Header records may contain aliases whose casing would otherwise send duplicates.
  const lowerName = name.toLowerCase();
  for (const header of Object.keys(headers)) {
    if (header.toLowerCase() === lowerName) delete headers[header];
  }
}

export function applyLiteLLMHeaders(
  headers: Record<string, string | null>,
  sessionId: string | undefined,
): void {
  // Replace case variants so the HTTP client cannot send a stale duplicate header.
  removeHeader(headers, "User-Agent");
  headers["User-Agent"] = USER_AGENT;
  removeHeader(headers, SESSION_HEADER);
  if (sessionId) headers[SESSION_HEADER] = sessionId;
}

export function applyChatUsageFlag(api: string, payload: unknown): unknown {
  // Preserve exact payload identity unless this is a streamed Chat Completions request.
  if (api !== "openai-completions" || !isRecord(payload) || payload.stream !== true) {
    return payload;
  }

  const streamOptions = isRecord(payload.stream_options) ? payload.stream_options : {};
  return {
    ...payload,
    stream_options: { ...streamOptions, include_usage: true },
  };
}

function numericHeader(headers: Record<string, string>, name: string): number | undefined {
  for (const [header, rawValue] of Object.entries(headers)) {
    // HTTP header names are case-insensitive; malformed duplicate values are ignored.
    if (header.toLowerCase() !== name.toLowerCase()) continue;
    const value = rawValue.trim();
    // Avoid Number coercions such as an empty string or hexadecimal-looking input.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readSpendHeaders(headers: Record<string, string>): {
  keySpend?: number;
  keyBudget?: number;
} {
  const keySpend = numericHeader(headers, "x-litellm-key-spend");
  const keyBudget = numericHeader(headers, "x-litellm-key-max-budget");
  return {
    ...(keySpend !== undefined ? { keySpend } : {}),
    ...(keyBudget !== undefined ? { keyBudget } : {}),
  };
}

export function registerTransport(
  pi: ExtensionAPI,
  state: HubState,
  deps: TransportDependencies = {},
): void {
  pi.on("before_provider_headers", (event, ctx) => {
    // A provider hook must not alter requests for any other active provider.
    if (ctx.model?.provider !== "litellm") return;
    const sessionId = deps.getSessionId
      ? deps.getSessionId(ctx)
      : ctx.sessionManager.getSessionId();
    applyLiteLLMHeaders(event.headers, sessionId);
  });

  pi.on("before_provider_request", (event, ctx) => {
    // Only LiteLLM requests use the gateway-specific stream-usage adjustment.
    if (ctx.model?.provider !== "litellm") return;
    return applyChatUsageFlag(ctx.model.api, event.payload);
  });

  pi.on("after_provider_response", (event, ctx) => {
    // Ignore unrelated response headers before touching spend state or status.
    if (ctx.model?.provider !== "litellm") return;
    const spend = readSpendHeaders(event.headers);
    if (spend.keySpend !== undefined) state.keySpend = spend.keySpend;
    if (spend.keyBudget !== undefined) state.keyBudget = spend.keyBudget;
    updateStatus(ctx, state);
  });
}
