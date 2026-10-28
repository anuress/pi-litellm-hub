import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HubState } from "./status.ts";
import { updateStatus } from "./status.ts";

const CACHE_MISS_REASON = "cache: missed 2 turns in row (gateway caching may be off)";

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

export function registerClaude(pi: ExtensionAPI, state: HubState): void {
  let consecutiveMisses = 0;

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;

    // Any other assistant model breaks the sequence of consecutive LiteLLM Claude turns.
    if (
      ctx.model?.provider !== "litellm" ||
      ctx.model.api !== "anthropic-messages" ||
      message.provider !== "litellm" ||
      message.api !== "anthropic-messages"
    ) {
      consecutiveMisses = 0;
      return;
    }

    const usage = message.usage;
    state.lastCache = cacheReason(usage);
    const isHit = usage.cacheRead > 0;
    const isMiss = usage.cacheWrite > 0 && usage.cacheRead === 0;
    if (isHit) {
      consecutiveMisses = 0;
      // Clear only this observer's warning once the gateway reports a real cache hit.
      if (state.reason === CACHE_MISS_REASON) state.reason = undefined;
    } else if (isMiss) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= 2) state.reason = CACHE_MISS_REASON;
    } else {
      // A Claude turn without a hit or miss also breaks the consecutive-miss streak.
      consecutiveMisses = 0;
    }

    updateStatus(ctx, state);
  });
}
