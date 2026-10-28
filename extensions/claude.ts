import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HubConfig } from "./config.ts";
import type { HubState } from "./status.ts";
import { updateStatus } from "./status.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays and null cannot have named Claude request properties.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCacheControl(value: unknown): unknown {
  // Traverse the complete request, including tools and nested message content.
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, nested]) => [key, stripCacheControl(nested)]),
  );
}

export function applyClaudeCache(payload: unknown, on: boolean): unknown {
  // pi-ai adds up to four system, conversation, and tool breakpoints; another may exceed Anthropic's limit.
  if (on) return payload;
  // Recursively clear all markers so disabled caching cannot write cache via any payload field.
  return stripCacheControl(payload);
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

    // Ignore cache rejections when caching was off already or has been disabled before.
    const cachingEnabled = cfg.claudeCache && !state.claudeCacheDisabled;
    if (
      cachingEnabled &&
      message.stopReason === "error" &&
      message.errorMessage?.toLowerCase().includes("cache_control")
    ) {
      // Store a fixed reason instead of exposing the provider's error text.
      state.claudeCacheDisabled = true;
      state.reason = "cache: rejected by gateway, caching off for this session";
      updateStatus(ctx, state);
      return;
    }

    // Report cache token usage only when this session was configured to send cache controls.
    if (!cachingEnabled) return;
    const reason = cacheReason(message.usage);
    if (reason) {
      state.reason = reason;
      updateStatus(ctx, state);
    }
  });
}
