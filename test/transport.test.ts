import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import packageInfo from "../package.json" with { type: "json" };
import { applyChatUsageFlag, applyLiteLLMHeaders, readSpendHeaders, registerTransport, USER_AGENT } from "../extensions/transport.ts";
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

function fakeContext(provider: string, api: string, sessionId = "session-test-123") {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    model: { provider, api, id: "model-test" },
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) },
  };
  return { ctx, statuses };
}

test("sets the package User-Agent and session id without changing Authorization", () => {
  const authorization = ["Bearer", "fake", "authorization"].join(" ");
  const headers: Record<string, string | null> = { Authorization: authorization, "x-extra": "keep" };

  applyLiteLLMHeaders(headers, "session-test-123");

  assert.equal(headers["User-Agent"], USER_AGENT);
  assert.equal(headers["x-litellm-session-id"], "session-test-123");
  assert.equal(headers.Authorization, authorization);
  assert.equal(headers["x-extra"], "keep");
});

test("omits a session header when the session id is unknown", () => {
  const headers: Record<string, string | null> = { "X-LiteLLM-Session-Id": "stale-session" };

  applyLiteLLMHeaders(headers, undefined);

  assert.equal(headers["User-Agent"], USER_AGENT);
  assert.equal(Object.keys(headers).some((key) => key.toLowerCase() === "x-litellm-session-id"), false);
});

test("adds usage reporting to streamed Chat Completions and preserves stream options", () => {
  const payload = {
    model: "chat-model",
    stream: true,
    stream_options: { include_obfuscation: false, existing: "keep" },
  };

  const result = applyChatUsageFlag("openai-completions", payload) as typeof payload;

  assert.deepEqual(result.stream_options, {
    include_obfuscation: false,
    existing: "keep",
    include_usage: true,
  });
  assert.notEqual(result, payload);
  assert.deepEqual(payload.stream_options, { include_obfuscation: false, existing: "keep" });
});

test("leaves OpenAI Responses payloads unchanged by reference", () => {
  const payload = { model: "responses-model", stream: true };

  assert.equal(applyChatUsageFlag("openai-responses", payload), payload);
});

test("reads numeric spend headers case-insensitively and ignores invalid values", () => {
  assert.deepEqual(
    readSpendHeaders({
      "X-LiteLLM-Key-Spend": "74.73",
      "x-litellm-key-max-budget": "200",
    }),
    { keySpend: 74.73, keyBudget: 200 },
  );
  assert.deepEqual(readSpendHeaders({ "X-LiteLLM-Key-Spend": "abc" }), {});
});

test("provider hooks leave another provider's headers and payload untouched", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerTransport(pi, state);
  const { ctx, statuses } = fakeContext("openai", "openai-completions");
  const headers: Record<string, string | null> = { Authorization: "Bearer fake-auth", custom: "value" };
  const originalHeaders = { ...headers };
  const payload = { model: "chat-model", stream: true };

  handlers.get("before_provider_headers")?.[0]({ headers }, ctx);
  const result = handlers.get("before_provider_request")?.[0]({ payload }, ctx);
  handlers.get("after_provider_response")?.[0](
    { status: 200, headers: { "x-litellm-key-spend": "74.73" } },
    ctx,
  );

  assert.deepEqual(headers, originalHeaders);
  assert.equal(result, undefined);
  assert.deepEqual(payload, { model: "chat-model", stream: true });
  assert.equal(state.keySpend, undefined);
  assert.equal(statuses.length, 0);
});

test("registered hooks add request metadata and update spend status for LiteLLM", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  state.activeModelId = "chat-model";
  registerTransport(pi, state);
  const { ctx, statuses } = fakeContext("litellm", "openai-completions");
  const authorization = "Bearer fake-auth";
  const headers: Record<string, string | null> = { Authorization: authorization };
  const payload = { model: "chat-model", stream: true };

  assert.equal(USER_AGENT, `pi-litellm-hub/${packageInfo.version}`);
  handlers.get("before_provider_headers")?.[0]({ headers }, ctx);
  const transformed = handlers.get("before_provider_request")?.[0]({ payload }, ctx) as {
    stream_options: { include_usage: boolean };
  };
  handlers.get("after_provider_response")?.[0](
    {
      status: 200,
      headers: {
        "X-LiteLLM-Key-Spend": "74.73",
        "X-LiteLLM-Key-Max-Budget": "200",
      },
    },
    ctx,
  );

  assert.equal(headers["User-Agent"], USER_AGENT);
  assert.equal(headers["x-litellm-session-id"], "session-test-123");
  assert.equal(headers.Authorization, authorization);
  assert.equal(transformed.stream_options.include_usage, true);
  assert.equal(state.keySpend, 74.73);
  assert.equal(state.keyBudget, 200);
  assert.equal(statuses.at(-1)?.key, "litellm");
  assert.match(statuses.at(-1)?.text ?? "", /\$74\.73\/\$200/);
});
