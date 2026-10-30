import type { HubConfig } from "./config.ts";
import {
  fetchGatewayModels,
  gatewayGetJson,
  type GatewayModel,
  type GatewayPriceField,
  type GatewayPrices,
} from "./gateway.ts";

const PRICE_MULTIPLIER = 1_000_000;
const CHAT_MODES = new Set(["chat", "responses"]);
const PRICE_FIELDS = [
  ["input", "input_cost_per_token"],
  ["output", "output_cost_per_token"],
  ["cacheRead", "cache_read_input_token_cost"],
  ["cacheWrite", "cache_creation_input_token_cost"],
] as const satisfies ReadonlyArray<readonly [GatewayPriceField, string]>;

export type GatewayDiscovery = {
  models: GatewayModel[];
  priceFallbackReason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function pricePerMillion(value: unknown): number | undefined {
  // Ignore malformed or overflowing prices instead of turning them into free or infinite rates.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const price = value * PRICE_MULTIPLIER;
  return Number.isFinite(price) ? price : undefined;
}

function parseRecord(
  item: Record<string, unknown>,
  metadata: Record<string, unknown>,
  idField: "model_group" | "model_name",
): GatewayModel | undefined {
  const id = item[idField];
  if (typeof id !== "string" || id.trim() === "") return undefined;

  // The gateway reports USD per token; Pi model costs use USD per million tokens.
  const prices: GatewayPrices = {};
  for (const [field, gatewayField] of PRICE_FIELDS) {
    const price = pricePerMillion(metadata[gatewayField]);
    if (price !== undefined) prices[field] = price;
  }
  const maxInputTokens = positiveInteger(metadata.max_input_tokens);
  const maxOutputTokens = positiveInteger(metadata.max_output_tokens);
  const mode = typeof metadata.mode === "string" && metadata.mode.trim() ? metadata.mode.trim() : undefined;
  return {
    id: id.trim(),
    ...(mode !== undefined ? { mode } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(Object.keys(prices).length ? { prices } : {}),
  };
}

function smaller(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function larger(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function restrictiveMode(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  // Any non-chat deployment keeps a shared alias from being registered as chat.
  return CHAT_MODES.has(left) && !CHAT_MODES.has(right) ? right : left;
}

// Multiple deployment rows are one model alias; keep the tightest limits and highest rates.
function mergeDeployments(models: GatewayModel[]): GatewayModel[] {
  const byId = new Map<string, GatewayModel>();
  for (const incoming of models) {
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, incoming);
      continue;
    }

    const prices: GatewayPrices = {};
    for (const [field] of PRICE_FIELDS) {
      const price = larger(current.prices?.[field], incoming.prices?.[field]);
      if (price !== undefined) prices[field] = price;
    }
    const maxInputTokens = smaller(current.maxInputTokens, incoming.maxInputTokens);
    const maxOutputTokens = smaller(current.maxOutputTokens, incoming.maxOutputTokens);
    const mode = restrictiveMode(current.mode, incoming.mode);
    byId.set(incoming.id, {
      id: incoming.id,
      ...(mode !== undefined ? { mode } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(Object.keys(prices).length ? { prices } : {}),
    });
  }
  return [...byId.values()];
}

function parseMetadata(payload: unknown, path: string, idField: "model_group" | "model_name"): GatewayModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`gateway ${path} returned invalid model metadata`);
  }

  const models = payload.data.flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const metadata = idField === "model_group"
      ? item
      : isRecord(item.model_info) ? item.model_info : undefined;
    if (!metadata) return [];
    const model = parseRecord(item, metadata, idField);
    return model ? [model] : [];
  });
  const merged = mergeDeployments(models);
  if (merged.length === 0) throw new Error(`gateway ${path} returned invalid model metadata`);
  return merged;
}

function failureReason(path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/ returned (\d{3})(?::|$)/)?.[1];
  // Auth failures are routine fallback signals; keep the final route-specific explanation concise.
  if (status === "401" || status === "403") return `key can't read ${path}`;
  // A missing endpoint is distinct from a key that cannot read an existing route.
  if (status === "404") return `gateway ${path} unavailable (404)`;
  if (status) return `gateway ${path} returned ${status}`;
  return message === "redirect refused (3xx)" ? `gateway ${path} redirect refused (3xx)` : message;
}

export async function discoverGatewayModels(
  config: HubConfig,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayDiscovery> {
  const routes = [
    { path: "/model_group/info", idField: "model_group" as const },
    { path: "/model/info", idField: "model_name" as const },
  ];
  let quietFailure: string | undefined;
  let visibleFailure: string | undefined;

  for (const route of routes) {
    try {
      const payload = await gatewayGetJson(config, apiKey, route.path, fetchImpl);
      // A usable metadata route already supplies IDs, so don't make a redundant /v1/models call.
      return { models: parseMetadata(payload, route.path, route.idField) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = failureReason(route.path, error);
      if (/ returned (?:401|403|404)(?::|$)/.test(message)) {
        quietFailure = reason;
      } else {
        visibleFailure ??= reason;
      }
    }
  }

  const models = await fetchGatewayModels(config, apiKey, fetchImpl);
  return {
    models,
    priceFallbackReason: visibleFailure ?? quietFailure ?? "model metadata unavailable",
  };
}
