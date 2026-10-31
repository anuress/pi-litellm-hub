import type { GatewayModel } from "./gateway.ts";
import type { PriceSources } from "./pricing.ts";
import { withGatewayPrices } from "./pricing.ts";
import { thinkingFor } from "./thinking.ts";

export { fetchGatewayModels, type GatewayModel } from "./gateway.ts";

export type Protocol = "anthropic-messages" | "openai-responses" | "openai-completions";

export type MatchedModel = {
  id: string;
  api: Protocol;
  catalogSource?: string;
  levels?: Record<string, string | null>;
  priceSources?: PriceSources;
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
const NON_CHAT_ID = /embedding|rerank|voyage|chirp|image|tts|whisper/i;
const NON_CHAT_REASON = "not a chat model";
const CHAT_MODES = new Set(["chat", "responses"]);

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

function unknownChatModel(id: string, gatewayModel: GatewayModel | undefined): MatchedModel {
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
      contextWindow: gatewayModel?.maxInputTokens ?? 128000,
      maxTokens: gatewayModel?.maxOutputTokens ?? 16384,
    },
  };
}

// Model-intrinsic compat flags; other catalog compat describes OpenAI-direct transport features the gateway does not forward.
const INTRINSIC_COMPAT = ["forceAdaptiveThinking", "supportsTemperature", "supportsStrictTools"];

function modelConfig(
  catalogModel: Record<string, any>,
  id: string,
  api: Protocol,
  levels: Record<string, string | null> | undefined,
  claudeCacheWarming: boolean,
): Record<string, unknown> {
  // Keep transport fields out; include promptCache only for explicitly enabled Anthropic models.
  const copied = Object.fromEntries(
    ["name", "reasoning", "input", "cost", "contextWindow", "maxTokens"]
      .filter((key) => key in catalogModel)
      .map((key) => [key, catalogModel[key]]),
  );
  const result: Record<string, unknown> = { ...copied, id, api };
  const compat = Object.fromEntries(
    INTRINSIC_COMPAT.filter((key) => isRecord(catalogModel.compat) && key in catalogModel.compat)
      .map((key) => [key, catalogModel.compat[key]]),
  );
  if (Object.keys(compat).length) result.compat = compat;
  // Never preserve a catalog map when thinkingFor did not approve levels.
  if (levels !== undefined) result.thinkingLevelMap = levels;
  if (claudeCacheWarming && api === "anthropic-messages") {
    const catalogPromptCache = Object.hasOwn(catalogModel, "promptCache")
      ? catalogModel.promptCache
      : undefined;
    result.promptCache = catalogPromptCache ?? { short: 300, long: 3600 };
  }
  return result;
}

function smaller(catalogValue: unknown, gatewayValue: number | undefined): number | undefined {
  if (gatewayValue === undefined) return undefined;
  return typeof catalogValue === "number" && catalogValue > 0
    ? Math.min(catalogValue, gatewayValue)
    : gatewayValue;
}

function withGatewayContextWindow(matched: MatchedModel, gatewayModel: GatewayModel | undefined): MatchedModel {
  const contextWindow = smaller(matched.model.contextWindow, gatewayModel?.maxInputTokens);
  if (contextWindow === undefined) return matched;
  return { ...matched, model: { ...matched.model, contextWindow } };
}

export function matchModels(
  ids: string[],
  catalog: Catalog,
  gatewayModels: GatewayModel[] = [],
  claudeCacheWarming = false,
): { models: MatchedModel[]; skipped: Skipped[] } {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const providers = catalog.providers();
  const entries = catalogEntries(catalog, providers);
  const ranks = providerRanks(providers);
  const models: MatchedModel[] = [];
  const skipped: Skipped[] = [];
  const listedById = new Map<string, GatewayModel>();
  for (const gatewayModel of gatewayModels) {
    const id = gatewayModel.id.trim();
    if (!listedById.has(id)) listedById.set(id, gatewayModel);
  }

  for (const id of uniqueIds) {
    const gatewayModel = listedById.get(id);
    if (gatewayModel?.mode !== undefined && !CHAT_MODES.has(gatewayModel.mode)) {
      skipped.push({ id, reason: NON_CHAT_REASON });
      continue;
    }
    const { candidates, vendorProviders } = candidatesForId(id, providers, entries);
    if (candidates.length === 0) {
      // Known media/embedding names are not safe guesses when gateway mode is absent.
      if (gatewayModel?.mode === undefined && NON_CHAT_ID.test(id)) skipped.push({ id, reason: NON_CHAT_REASON });
      else models.push(withGatewayPrices(unknownChatModel(id, gatewayModel), gatewayModel));
      continue;
    }

    const preferred = preferredCandidates(candidates, vendorProviders, ranks);
    const first = preferred[0];
    // A matching image or classifier entry must never be registered as chat.
    if (first.model.type !== undefined && first.model.type !== "chat") {
      skipped.push({ id, reason: NON_CHAT_REASON });
      continue;
    }
    // Only equal-priority entries can be ambiguous; lower-priority maps are ignored.
    const ambiguous = preferred.some(
      ({ model }) => !deepEqual(model.thinkingLevelMap, first.model.thinkingLevelMap),
    );
    const thinking: ReturnType<typeof thinkingFor> = ambiguous
      ? { reason: "ambiguous catalog match" }
      : thinkingFor(first.model, id);
    const api = protocolFor(first.model.api);

    models.push(withGatewayPrices(withGatewayContextWindow({
      id,
      api,
      catalogSource: first.provider,
      ...(thinking.levels !== undefined ? { levels: thinking.levels } : {}),
      ...(thinking.reason !== undefined ? { reason: thinking.reason } : {}),
      model: modelConfig(first.model, id, api, thinking.levels, claudeCacheWarming),
    }, gatewayModel), gatewayModel));
  }

  return { models, skipped };
}
