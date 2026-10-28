import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyClaudeCache, cacheReason, registerClaude } from "../extensions/claude.ts";
import type { HubConfig } from "../extensions/config.ts";
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

function config(claudeCache: boolean): HubConfig {
  return { baseUrl: "https://gateway.invalid", apiKeyRef: "$FAKE_KEY", claudeCache };
}

function hasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCacheControl);
  if (typeof value !== "object" || value === null) return false;
  if (Object.hasOwn(value, "cache_control")) return true;
  return Object.values(value).some(hasCacheControl);
}

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "litellm",
    model: "claude-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

test("cache-on converts a string system prompt into a cached text block without mutation", () => {
  const payload = { system: "Follow these instructions", messages: [{ role: "user", content: "Hi" }] };
  const original = structuredClone(payload);

  const result = applyClaudeCache(payload, true) as typeof payload & { system: unknown[] };

  assert.deepEqual(result.system, [
    { type: "text", text: "Follow these instructions", cache_control: { type: "ephemeral" } },
  ]);
  assert.notEqual(result, payload);
  assert.deepEqual(payload, original);
});

test("cache-on marks only the last existing system block", () => {
  const payload = {
    system: [{ type: "text", text: "First" }, { type: "text", text: "Last" }],
    messages: [],
  };
  const result = applyClaudeCache(payload, true) as typeof payload;

  assert.equal("cache_control" in result.system[0], false);
  assert.deepEqual(result.system[1], {
    type: "text",
    text: "Last",
    cache_control: { type: "ephemeral" },
  });
  assert.equal("cache_control" in payload.system[1], false);
});

test("cache-off recursively strips controls from system and messages without mutation", () => {
  const payload = {
    system: [{ type: "text", text: "Rules", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hi", metadata: { cache_control: { type: "ephemeral" } } }],
      },
    ],
  };
  const original = structuredClone(payload);

  const result = applyClaudeCache(payload, false);

  assert.equal(hasCacheControl(result), false);
  assert.equal(hasCacheControl(payload), true);
  assert.deepEqual(payload, original);
});

test("formats cached token counts for hit and miss reasons", () => {
  assert.equal(cacheReason({ cacheWrite: 13500 }), "cache: miss (wrote 13.5k, read 0)");
  assert.equal(cacheReason({ cacheRead: 9902 }), "cache: hit (read 9.9k)");
  assert.equal(cacheReason({ cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("Claude request hooks are gated to LiteLLM Anthropic Messages", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state, config(true));
  const { ctx } = fakeContext("openai", "anthropic-messages");
  const payload = { system: "Leave this payload unchanged", messages: [] };
  const result = handlers.get("before_provider_request")?.[0]({ payload }, ctx);

  handlers.get("message_end")?.[0](
    {
      message: assistant({ provider: "litellm", stopReason: "error", errorMessage: "cache_control rejected" }),
    },
    ctx,
  );

  assert.equal(result, undefined);
  assert.equal(payload.system, "Leave this payload unchanged");
  assert.equal(state.claudeCacheDisabled, undefined);
  assert.equal(state.reason, undefined);
});

test("records cache usage for a LiteLLM Claude assistant response when enabled", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state, config(true));
  const { ctx } = fakeContext("litellm", "anthropic-messages");

  handlers.get("message_end")?.[0](
    { message: assistant({ usage: { cacheRead: 9902, cacheWrite: 0 } }) },
    ctx,
  );

  assert.equal(state.reason, "cache: hit (read 9.9k)");
});

test("a cache_control rejection disables cache for subsequent requests in the session", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerClaude(pi, state, config(true));
  const { ctx } = fakeContext("litellm", "anthropic-messages");
  const beforeRequest = handlers.get("before_provider_request")?.[0];
  const rejectedPayload = { system: "Rules", messages: [] };
  const first = beforeRequest?.({ payload: rejectedPayload }, ctx) as { system: unknown[] };

  assert.equal(hasCacheControl(first.system), true);
  handlers.get("message_end")?.[0](
    {
      message: assistant({
        stopReason: "error",
        errorMessage: "gateway rejected cache_control in this request",
      }),
    },
    ctx,
  );

  const nextPayload = {
    system: [{ type: "text", text: "Rules", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] }],
  };
  const next = beforeRequest?.({ payload: nextPayload }, ctx);

  assert.equal(state.claudeCacheDisabled, true);
  assert.equal(state.reason, "cache: rejected by gateway, caching off for this session");
  assert.equal(hasCacheControl(next), false);
  assert.equal(hasCacheControl(nextPayload), true);
});

test("configured-off Claude caching strips pre-existing cache controls", () => {
  const { pi, handlers } = fakeRuntime();
  registerClaude(pi, newHubState(), config(false));
  const { ctx } = fakeContext("litellm", "anthropic-messages");
  const payload = { system: "Rules", messages: [{ content: [{ cache_control: { type: "ephemeral" } }] }] };
  const result = handlers.get("before_provider_request")?.[0]({ payload }, ctx);

  assert.equal(hasCacheControl(result), false);
  assert.equal(hasCacheControl(payload), true);
});
