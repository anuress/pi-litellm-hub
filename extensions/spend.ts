import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HubConfig } from "./config.ts";
import { gatewayGetJson } from "./gateway.ts";
import { readSpendHeaders } from "./transport.ts";
import { updateStatus, type HubState } from "./status.ts";

type CostParts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type CostMessage = {
  usage: {
    cost: CostParts;
  };
};

type KeyWindow = { resetAt?: string; window?: string };

export type SpendDependencies = {
  config: HubConfig;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function costFromStreamEvent(api: string, data: unknown): number | undefined {
  try {
    const event = asRecord(data);
    if (!event) return undefined;

    let value: unknown;
    if (api === "openai-responses") {
      if (event.type !== "response.completed") return undefined;
      value = asRecord(asRecord(event.response)?.usage)?.cost;
    } else if (api === "openai-completions") {
      value = asRecord(event.usage)?.cost;
    } else {
      return undefined;
    }

    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  } catch {
    // Provider adapters own event objects; malformed accessors are not fatal to a turn.
    return undefined;
  }
}

export function applyGatewayCost<T extends CostMessage>(
  message: T,
  cost: number | undefined,
): { message: T; exact: boolean } {
  if (cost === undefined) return { message, exact: false };

  const original = message.usage.cost;
  let scaled: Omit<CostParts, "total">;
  if (original.total === 0) {
    // With no pi estimate to scale, attribute the full gateway charge to output.
    scaled = { input: 0, output: cost, cacheRead: 0, cacheWrite: 0 };
  } else {
    const ratio = cost / original.total;
    scaled = {
      input: original.input * ratio,
      output: original.output * ratio,
      cacheRead: original.cacheRead * ratio,
      cacheWrite: original.cacheWrite * ratio,
    };
  }

  const replacement = {
    ...message,
    usage: {
      ...message.usage,
      cost: { ...original, ...scaled, total: cost },
    },
  } as T;
  return { message: replacement, exact: true };
}

export function parseKeyWindow(json: unknown): KeyWindow {
  try {
    const info = asRecord(asRecord(json)?.info);
    if (!info) return {};

    return {
      ...(typeof info.budget_reset_at === "string" ? { resetAt: info.budget_reset_at } : {}),
      ...(typeof info.budget_duration === "string" ? { window: info.budget_duration } : {}),
    };
  } catch {
    // Ignore malformed responses rather than exposing or retaining other key metadata.
    return {};
  }
}

export async function loadKeyWindow(
  cfg: HubConfig,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<KeyWindow> {
  try {
    const json = await gatewayGetJson(cfg, apiKey, "/key/info", fetchImpl);
    return parseKeyWindow(json);
  } catch {
    // Key-window status is best effort and must never block session startup.
    return {};
  }
}

export function registerSpend(
  pi: ExtensionAPI,
  state: HubState,
  deps: SpendDependencies,
): void {
  let turnCost: number | undefined;
  let pendingKeySpend: number | undefined;
  let keyWindowRequested = false;

  pi.on("turn_start", () => {
    turnCost = undefined;
    pendingKeySpend = undefined;
  });

  pi.on("provider_stream_event", (event) => {
    if (event.provider !== "litellm") return;
    const cost = costFromStreamEvent(event.api, event.data);
    if (cost !== undefined) turnCost = cost;
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== "litellm") return;
    // The transport hook still owns displayed headers; this captures their pre-turn spend once.
    pendingKeySpend = readSpendHeaders(event.headers).keySpend;
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (
      ctx.model?.provider !== "litellm" ||
      message.role !== "assistant" ||
      message.provider !== "litellm"
    ) {
      return;
    }
    let reconciledMessage = message;
    let total: number;
    let exact: boolean;
    if (message.usage?.cost) {
      const result = applyGatewayCost(message, turnCost);
      reconciledMessage = result.message;
      total = result.message.usage.cost.total;
      exact = result.exact;
    } else if (turnCost !== undefined) {
      total = turnCost;
      exact = true;
      reconciledMessage = {
        ...message,
        usage: {
          ...message.usage,
          cost: {
            input: 0,
            output: turnCost,
            cacheRead: 0,
            cacheWrite: 0,
            total: turnCost,
          },
        },
      } as typeof message;
    } else {
      turnCost = undefined;
      pendingKeySpend = undefined;
      return;
    }

    state.sessionCost += total;
    if (!exact) state.sessionEstimated = true;
    if (pendingKeySpend !== undefined) state.keySpend = pendingKeySpend + total;

    turnCost = undefined;
    pendingKeySpend = undefined;
    updateStatus(ctx, state, deps.apiKey);
    if (exact) return { message: reconciledMessage };
  });

  pi.on("session_start", (_event, ctx) => {
    if (keyWindowRequested) return;
    keyWindowRequested = true;

    // Fetch once in the background; only the two display-safe fields enter HubState.
    void loadKeyWindow(deps.config, deps.apiKey, deps.fetchImpl).then((window) => {
      state.resetAt = window.resetAt;
      state.window = window.window;
      updateStatus(ctx, state, deps.apiKey);
    });
  });
}
