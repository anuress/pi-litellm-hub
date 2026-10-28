import packageInfo from "../package.json" with { type: "json" };
import type { HubConfig } from "./config.ts";
import { redact } from "./redact.ts";
import { thinkingFor } from "./thinking.ts";

export type Protocol = "anthropic-messages" | "openai-responses" | "openai-completions";

export type MatchedModel = {
  id: string;
  api: Protocol;
  catalogSource?: string;
  levels?: Record<string, string | null>;
  reason?: string;
  model: Record<string, unknown>;
};

export type Skipped = { id: string; reason: string };

export type Catalog = {
  providers: () => string[];
  models: (provider: string) => Array<Record<string, any>>;
};

type CatalogEntry = { provider: string; model: Record<string, any> };

const USER_AGENT = `pi-litellm-hub/${packageInfo.version}`;
const NON_CHAT_ID = /embedding|rerank|voyage|chirp|image|tts|whisper/i;
const NON_CHAT_REASON = "not a chat model";

function isRecord(value: unknown): value is Record<string, any> {
  // Arrays and null do not have the named fields used by gateway and catalog objects.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  // Reuse identical primitive and reference values without descending.
  if (Object.is(left, right)) return true;
  // Distinct primitive values cannot represent equal nested catalog data.
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  // Arrays are ordered, unlike the object keys used by effort maps.
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }

  // Compare own keys and values so insertion order does not create false ambiguity.
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function protocolFor(api: unknown): Protocol {
  // Anthropic Messages remains distinct from the OpenAI-compatible endpoints.
  if (api === "anthropic-messages") return "anthropic-messages";
  // Azure Responses uses pi's standard OpenAI Responses adapter.
  if (api === "openai-responses" || api === "azure-openai-responses") return "openai-responses";
  // Unknown APIs deliberately fall back to the supported completions protocol.
  return "openai-completions";
}

function catalogEntries(catalog: Catalog, providers: string[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const provider of providers) {
    for (const model of catalog.models(provider)) {
      // Ignore malformed injected entries that cannot match a gateway id.
      if (isRecord(model) && typeof model.id === "string") entries.push({ provider, model });
    }
  }
  return entries;
}

function candidatesForId(
  id: string,
  providers: string[],
  entries: CatalogEntry[],
): CatalogEntry[] {
  // A full catalog id always takes priority over vendor-prefix stripping.
  const exactMatches = entries.filter((entry) => entry.model.id === id);
  if (exactMatches.length > 0) return exactMatches;

  const slash = id.indexOf("/");
  // Only ids with a non-empty vendor and model part have a vendor prefix.
  if (slash <= 0 || slash === id.length - 1) return [];

  const vendor = id.slice(0, slash).toLowerCase();
  const strippedId = id.slice(slash + 1);
  // The provider name may equal the vendor or include it as a longer provider id.
  const vendorProviders = new Set(
    providers.filter((provider) => {
      const normalizedProvider = provider.toLowerCase();
      return normalizedProvider === vendor || normalizedProvider.includes(vendor);
    }),
  );
  // Prefer the vendor's own catalog before trying the stripped id globally.
  const vendorMatches = entries.filter(
    (entry) => vendorProviders.has(entry.provider) && entry.model.id === strippedId,
  );
  if (vendorMatches.length > 0) return vendorMatches;

  return entries.filter((entry) => entry.model.id === strippedId);
}

function unknownChatModel(id: string): MatchedModel {
  // Unknown aliases get a conservative text-only model shape with a visible reason.
  const api: Protocol = "openai-completions";
  return {
    id,
    api,
    reason: "not in pi's catalog",
    model: {
      type: "chat",
      id,
      name: id,
      api,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    },
  };
}

function modelConfig(
  catalogModel: Record<string, any>,
  id: string,
  api: Protocol,
  levels: Record<string, string | null> | undefined,
): Record<string, unknown> {
  // Provider identity and endpoint belong to the provider registration, not its model config.
  const copied = Object.fromEntries(
    Object.entries(catalogModel).filter(
      ([key]) =>
        key !== "provider" &&
        key !== "baseUrl" &&
        key !== "thinkingLevelMap" &&
        key !== "id" &&
        key !== "api",
    ),
  );
  const result: Record<string, unknown> = { ...copied, id, api };
  // Never preserve a catalog map when thinkingFor did not approve levels.
  if (levels !== undefined) result.thinkingLevelMap = levels;
  return result;
}

export function matchModels(
  ids: string[],
  catalog: Catalog,
): { models: MatchedModel[]; skipped: Skipped[] } {
  const providers = catalog.providers();
  const entries = catalogEntries(catalog, providers);
  const models: MatchedModel[] = [];
  const skipped: Skipped[] = [];

  for (const id of ids) {
    const candidates = candidatesForId(id, providers, entries);
    if (candidates.length === 0) {
      // Known media/embedding names are not safe guesses for chat models.
      if (NON_CHAT_ID.test(id)) skipped.push({ id, reason: NON_CHAT_REASON });
      else models.push(unknownChatModel(id));
      continue;
    }

    // A matching image or classifier entry must never be registered as chat.
    if (candidates.some(({ model }) => model.type !== undefined && model.type !== "chat")) {
      skipped.push({ id, reason: NON_CHAT_REASON });
      continue;
    }

    const first = candidates[0];
    // A conflicting effort map is not safe to choose; identical maps retain provider order.
    const ambiguous = candidates.some(
      ({ model }) => !deepEqual(model.thinkingLevelMap, first.model.thinkingLevelMap),
    );
    const thinking = ambiguous
      ? { reason: "ambiguous catalog match" }
      : thinkingFor(first.model, id);
    const api = protocolFor(first.model.api);

    models.push({
      id,
      api,
      catalogSource: first.provider,
      ...(thinking.levels !== undefined ? { levels: thinking.levels } : {}),
      ...(thinking.reason !== undefined ? { reason: thinking.reason } : {}),
      model: modelConfig(first.model, id, api, thinking.levels),
    });
  }

  return { models, skipped };
}

function errorMessage(error: unknown): string {
  // Preserve useful native failure text; callers redact it before constructing an Error.
  return error instanceof Error ? error.message : String(error);
}

export async function fetchGatewayIds(
  cfg: HubConfig,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  // Normalize a trailing slash so the configured gateway root yields one /v1 segment.
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
    });
  } catch (error) {
    // Fetch errors may include request details, so sanitize the message with the caller's key.
    throw new Error(redact(`gateway /v1/models request failed: ${errorMessage(error)}`, apiKey));
  }

  // Never follow or accept redirects for a credential-bearing catalog request.
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new Error(redact("redirect refused (3xx)", apiKey));
  }

  // Report bounded response text on failures, after redaction below.
  if (response.status < 200 || response.status >= 300) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // The status remains useful even if a failed response body cannot be read.
    }
    throw new Error(
      redact(`gateway /v1/models returned ${response.status}: ${body.slice(0, 200)}`, apiKey),
    );
  }

  // A malformed success body is a gateway failure, not an empty catalog.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      redact(`gateway /v1/models returned invalid JSON: ${errorMessage(error)}`, apiKey),
    );
  }

  // A successful response without the documented data list is malformed, not an empty catalog.
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(redact("gateway /v1/models returned an invalid model list", apiKey));
  }
  // Ignore malformed entries while retaining every string model id from the data list.
  return payload.data.flatMap((item: unknown) =>
    isRecord(item) && typeof item.id === "string" ? [item.id] : [],
  );
}
