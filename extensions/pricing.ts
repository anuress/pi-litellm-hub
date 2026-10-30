import type { GatewayModel, GatewayPriceField } from "./gateway.ts";

export type PriceSource = "gateway" | "pi catalog" | "default" | "unavailable";
export type PriceSources = Record<GatewayPriceField, PriceSource>;

type PricedModel = {
  catalogSource?: string;
  model: Record<string, unknown>;
};

const PRICE_FIELDS: GatewayPriceField[] = ["input", "output", "cacheRead", "cacheWrite"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withGatewayPrices<T extends PricedModel>(
  matched: T,
  gatewayModel: GatewayModel | undefined,
): T & { priceSources: PriceSources } {
  const catalogCost = isRecord(matched.model.cost) ? matched.model.cost : undefined;
  const cost: Record<string, unknown> = { ...catalogCost };
  const priceSources = {} as PriceSources;
  let usedGatewayPrice = false;

  for (const field of PRICE_FIELDS) {
    // A missing gateway value keeps the catalog field; it must not become a free price.
    const price = gatewayModel?.prices?.[field];
    if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
      cost[field] = price;
      priceSources[field] = "gateway";
      usedGatewayPrice = true;
    } else if (catalogCost && Object.hasOwn(catalogCost, field)) {
      priceSources[field] = matched.catalogSource ? "pi catalog" : "default";
    } else {
      priceSources[field] = "unavailable";
    }
  }

  return {
    ...matched,
    priceSources,
    ...(usedGatewayPrice ? { model: { ...matched.model, cost } } : {}),
  };
}
