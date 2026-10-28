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

// First-party metadata is most accurate for a vendor's own model; aggregators and fallback providers follow.
export const PROVIDER_PRIORITY = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "moonshotai",
  "zai",
  "deepseek",
  "mistral",
  "meta",
  "openrouter",
  "opencode",
] as const;

const VENDOR_PROVIDER_HINTS: Record<string, string> = {
  moonshotai: "moonshot",
  "z-ai": "zai",
  "x-ai": "xai",
  deepseek: "deepseek",
  google: "google",
  gemini: "google",
};
const USER_AGENT = `pi-litellm-hub/${packageInfo.version}`;
const NON_CHAT_ID = /embedding|rerank|voyage|chirp|image|tts|whisper/i;
const NON_CHAT_REASON = "not a chat model";

function isRecord(value: unknown): value is Record<string, any> {
  // Arrays and null do not have the named fields used by gateway and catalog objects.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  // Thinking maps are JSON-shaped; recurse through ordered arrays and key-order-independent records.
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function protocolFor(api: unknown): Protocol {
  // Preserve supported APIs, normalize Azure Responses, and default unknown APIs to completions.
  if (api === "anthropic-messages") return "anthropic-messages";
  if (api === "openai-responses" || api === "azure-openai-responses") return "openai-responses";
  return "openai-completions";
}
function catalogEntries(catalog: Catalog, providers: string[]): CatalogEntry[] {
  return providers.flatMap((provider) =>
    catalog.models(provider)
      .filter((model) => isRecord(model) && typeof model.id === "string")
      .map((model) => ({ provider, model })),
  );
}

function providerRanks(providers: string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  PROVIDER_PRIORITY.forEach((provider, index) => ranks.set(provider, index));
  // Providers outside the named list use a stable alphabetical fallback rank.
  [...new Set(providers.map((provider) => provider.toLowerCase()))]
    .filter((provider) => !ranks.has(provider))
    .sort()
    .forEach((provider, index) => ranks.set(provider, PROVIDER_PRIORITY.length + index));
  return ranks;
}
function candidatesForId(
  id: string,
  providers: string[],
  entries: CatalogEntry[],
): { candidates: CatalogEntry[]; vendorProviders: Set<string> } {
  const slash = id.indexOf("/");
  const vendor = slash > 0 && slash < id.length - 1 ? id.slice(0, slash).toLowerCase() : undefined;
  // Treat unknown prefixes as literal hints without consulting inherited object properties.
  const hint = vendor && Object.hasOwn(VENDOR_PROVIDER_HINTS, vendor) ? VENDOR_PROVIDER_HINTS[vendor] : vendor;
  const vendorProviders = new Set(
    hint ? providers.filter((provider) => provider.toLowerCase().includes(hint)).map((p) => p.toLowerCase()) : [],
  );
  // A full catalog id wins before trying its vendor-stripped form.
  const exact = entries.filter((entry) => entry.model.id === id);
  if (exact.length) return { candidates: exact, vendorProviders };
  if (!vendor || slash === id.length - 1) return { candidates: [], vendorProviders };

  // Prefer a matching vendor provider; if none lists the id, search every provider.
  const strippedId = id.slice(slash + 1);
  const vendorMatches = entries.filter(
    (entry) => vendorProviders.has(entry.provider.toLowerCase()) && entry.model.id === strippedId,
  );
  return {
    candidates: vendorMatches.length ? vendorMatches : entries.filter((entry) => entry.model.id === strippedId),
    vendorProviders,
  };
}

function preferredCandidates(
  candidates: CatalogEntry[],
  vendorProviders: Set<string>,
  ranks: Map<string, number>,
): CatalogEntry[] {
  let bestRank: [number, number] | undefined;
  const preferred: CatalogEntry[] = [];
  for (const entry of candidates) {
    // Vendor-aligned providers rank first, then use the fixed or alphabetical provider order.
    const provider = entry.provider.toLowerCase();
    const rank: [number, number] = [vendorProviders.has(provider) ? 0 : 1, ranks.get(provider) ?? ranks.size];
    const comparison = !bestRank ? -1 : rank[0] - bestRank[0] || rank[1] - bestRank[1];
    if (comparison < 0) {
      bestRank = rank;
      preferred.length = 0;
      preferred.push(entry);
    } else if (bestRank && comparison === 0) preferred.push(entry);
  }
  return preferred;
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
  const ranks = providerRanks(providers);
  const models: MatchedModel[] = [];
  const skipped: Skipped[] = [];

  for (const id of ids) {
    const { candidates, vendorProviders } = candidatesForId(id, providers, entries);
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

    const preferred = preferredCandidates(candidates, vendorProviders, ranks);
    const first = preferred[0];
    // Only equal-priority entries can be ambiguous; lower-priority maps are ignored.
    const ambiguous = preferred.some(
      ({ model }) => !deepEqual(model.thinkingLevelMap, first.model.thinkingLevelMap),
    );
    const thinking: ReturnType<typeof thinkingFor> = ambiguous
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
