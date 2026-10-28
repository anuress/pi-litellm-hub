import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cacheReason, registerClaude } from "../extensions/claude.ts";
import { newHubState } from "../extensions/status.ts";

type Handler = (event: any, ctx: any) => unknown;

function fakeRuntime() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (event: string, handler: Handler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
      return () => handlers.set(event, registered.filter((item) => item !== handler));
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

function fakeContext(provider: string, api: string) {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    model: { provider, api, id: "claude-test" },
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) },
  };
  return { ctx, statuses };
}

function assistant(cacheRead: number, cacheWrite: number) {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "litellm",
    model: "claude-test",
    usage: { cacheRead, cacheWrite },
  };
}

function emitUsage(handlers: Map<string, Handler[]>, ctx: any, cacheRead: number, cacheWrite: number) {
  handlers.get("message_end")?.[0]({ message: assistant(cacheRead, cacheWrite) }, ctx);
}

test("formats cache hit and miss token counts", () => {
  assert.equal(cacheReason({ cacheWrite: 13500 }), "cache: miss (wrote 13.5k, read 0)");
  assert.equal(cacheReason({ cacheRead: 9902 }), "cache: hit (read 9.9k)");
  assert.equal(cacheReason({ cacheRead: 10278 }), "cache: hit (read 10.3k)");
  assert.equal(cacheReason({ cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("ignores messages unless the active model is LiteLLM Anthropic Messages", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state);
  const { ctx } = fakeContext("openai", "anthropic-messages");

  emitUsage(handlers, ctx, 10278, 0);

  assert.equal(state.lastCache, undefined);
  assert.equal(state.reason, undefined);
});

test("a first cache miss is informational and does not set a reason", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state);
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  emitUsage(handlers, ctx, 0, 13500);

  assert.equal(state.lastCache, "cache: miss (wrote 13.5k, read 0)");
  assert.equal(state.reason, undefined);
});

test("two consecutive Claude cache misses set the gateway warning", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state);
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  emitUsage(handlers, ctx, 0, 13500);
  emitUsage(handlers, ctx, 0, 12000);

  assert.equal(state.reason, "cache: missed 2 turns in row (gateway caching may be off)");
  assert.equal(state.lastCache, "cache: miss (wrote 12k, read 0)");
});

test("a cache hit resets the miss streak", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state);
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  emitUsage(handlers, ctx, 0, 13500);
  emitUsage(handlers, ctx, 10278, 0);
  emitUsage(handlers, ctx, 0, 12000);

  assert.equal(state.reason, undefined);
  assert.equal(state.lastCache, "cache: miss (wrote 12k, read 0)");
});

test("a cache hit clears this observer's existing miss warning", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state);
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  emitUsage(handlers, ctx, 0, 13500);
  emitUsage(handlers, ctx, 0, 12000);
  assert.equal(state.reason, "cache: missed 2 turns in row (gateway caching may be off)");

  emitUsage(handlers, ctx, 10278, 0);

  assert.equal(state.reason, undefined);
  assert.equal(state.lastCache, "cache: hit (read 10.3k)");
});

test("a no-cache-data Claude turn breaks the streak but preserves the warning", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state);
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  emitUsage(handlers, ctx, 0, 13500);
  emitUsage(handlers, ctx, 0, 12000);
  emitUsage(handlers, ctx, 0, 0);

  assert.equal(state.reason, "cache: missed 2 turns in row (gateway caching may be off)");
  assert.equal(state.lastCache, undefined);
});

test("a cache hit does not clear an unrelated reason", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  state.reason = "gateway unavailable";
  registerClaude(pi, state);
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  emitUsage(handlers, ctx, 10278, 0);

  assert.equal(state.reason, "gateway unavailable");
});

test("an intervening assistant from another provider breaks the miss streak", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state);
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  emitUsage(handlers, ctx, 0, 13500);
  handlers.get("message_end")?.[0](
    { message: { role: "assistant", provider: "openai", api: "openai-responses", usage: {} } },
    fakeContext("openai", "openai-responses").ctx,
  );
  emitUsage(handlers, ctx, 0, 12000);

  assert.equal(state.reason, undefined);
});
