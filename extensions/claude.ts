import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HubConfig } from "./config.ts";
import type { HubState } from "./status.ts";
import { updateStatus } from "./status.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays and null cannot have named Claude request properties.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCacheControl(value: unknown): unknown {
  // Traverse arrays and objects to remove controls even from nested message content.
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, nested]) => [key, stripCacheControl(nested)]),
  );
}

export function applyClaudeCache(payload: unknown, on: boolean): unknown {
  if (!isRecord(payload)) return payload;

  if (!on) {
    // A disabled cache must also remove controls already present in incoming payloads.
    const copy = { ...payload };
    if (Object.hasOwn(payload, "system")) copy.system = stripCacheControl(payload.system);
    if (Object.hasOwn(payload, "messages")) copy.messages = stripCacheControl(payload.messages);
    return copy;
  }

  // Anthropic accepts string prompts, but caching metadata requires a system content block.
  if (typeof payload.system === "string") {
    return {
      ...payload,
      system: [{ type: "text", text: payload.system, cache_control: { type: "ephemeral" } }],
    };
  }
  // Do not invent a system prompt when this otherwise-valid payload has no system blocks.
  if (!Array.isArray(payload.system)) return { ...payload };

  const system = payload.system.slice();
  // The API's prompt caching boundary is the final system block, not message content.
  const lastIndex = system.length - 1;
  if (lastIndex >= 0 && isRecord(system[lastIndex])) {
    system[lastIndex] = { ...system[lastIndex], cache_control: { type: "ephemeral" } };
  }
  return { ...payload, system };
}

function formatTokens(tokens: number): string {
  // Keep sub-thousand counts exact and show larger counts compactly to one decimal place.
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function cacheReason(usage: {
  cacheRead?: number;
  cacheWrite?: number;
}): string | undefined {
  // Any positive read means a hit, even if the same response also wrote new cache tokens.
  if (usage.cacheRead !== undefined && usage.cacheRead > 0) {
    return `cache: hit (read ${formatTokens(usage.cacheRead)})`;
  }
  if (usage.cacheWrite !== undefined && usage.cacheWrite > 0 && !usage.cacheRead) {
    return `cache: miss (wrote ${formatTokens(usage.cacheWrite)}, read 0)`;
  }
  return undefined;
}

export function registerClaude(pi: ExtensionAPI, state: HubState, cfg: HubConfig): void {
  pi.on("before_provider_request", (event, ctx) => {
    // The Anthropic cache format must not leak into another provider or LiteLLM API.
    if (ctx.model?.provider !== "litellm" || ctx.model.api !== "anthropic-messages") return;
    return applyClaudeCache(event.payload, cfg.claudeCache && !state.claudeCacheDisabled);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    // Use the request's model context so error responses still get handled when message metadata is incomplete.
    if (ctx.model?.provider !== "litellm" || ctx.model.api !== "anthropic-messages") return;
    if (
      message.role !== "assistant" ||
      message.provider !== "litellm" ||
      message.api !== "anthropic-messages"
    ) return;

    if (message.stopReason === "error" && message.errorMessage?.toLowerCase().includes("cache_control")) {
      // Pi exposes the parsed error message here, not the HTTP response body or a retry hook.
      state.claudeCacheDisabled = true;
      state.reason = "cache: rejected by gateway, caching off for this session";
      updateStatus(ctx, state);
      return;
    }

    // Report cache token usage only when this session was configured to send cache controls.
    if (!cfg.claudeCache || state.claudeCacheDisabled) return;
    const reason = cacheReason(message.usage);
    if (reason) {
      state.reason = reason;
      updateStatus(ctx, state);
    }
  });
}
