import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGatewayCost,
  costFromStreamEvent,
  loadKeyWindow,
  parseKeyWindow,
  registerSpend,
} from "../extensions/spend.ts";
import { newHubState } from "../extensions/status.ts";

const cfg = { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY" };
const apiKey = ["fake", "gateway", "key"].join("-");

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
  return { pi, handlers };
}

function fakeContext(provider = "litellm", api = "openai-responses") {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    model: { provider, api, id: "test-model" },
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) },
  };
  return { ctx, statuses };
}

function assistantMessage(api: string, total: number) {
  return {
    role: "assistant",
    provider: "litellm",
    api,
    model: "test-model",
    content: [],
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0, total },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

test("extracts only supported LiteLLM stream costs and rejects malformed values", () => {
  assert.equal(
    costFromStreamEvent("openai-responses", {
      type: "response.completed",
      response: { usage: { cost: 3.3e-6 } },
    }),
    3.3e-6,
  );
  assert.equal(
    costFromStreamEvent("openai-completions", { usage: { cost: 2.8e-6 } }),
    2.8e-6,
  );
  assert.equal(
    costFromStreamEvent("anthropic-messages", { type: "message_delta", usage: { cost: 1 } }),
    undefined,
  );
  assert.equal(costFromStreamEvent("openai-responses", { type: "response.created" }), undefined);
  for (const data of [
    { type: "response.completed", response: { usage: { cost: Number.NaN } } },
    { type: "response.completed", response: { usage: { cost: -1 } } },
    { type: "response.completed", response: { usage: { cost: "3.3" } } },
    null,
  ]) {
    assert.equal(costFromStreamEvent("openai-responses", data), undefined);
  }
});

test("replaces pi cost proportionally without mutating the original message", () => {
  const message = assistantMessage("openai-responses", 4);
  const original = structuredClone(message);

  const result = applyGatewayCost(message, 8);

  assert.equal(result.exact, true);
  assert.notEqual(result.message, message);
  assert.notEqual(result.message.usage, message.usage);
  assert.notEqual(result.message.usage.cost, message.usage.cost);
  assert.deepEqual(result.message.usage.cost, {
    input: 2,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    total: 8,
  });
  assert.deepEqual(message, original);

  const unchanged = applyGatewayCost(message, undefined);
  assert.equal(unchanged.message, message);
  assert.equal(unchanged.exact, false);
  assert.deepEqual(message, original);
});

test("puts a gateway cost in output when pi's estimated total is zero", () => {
  const message = assistantMessage("openai-responses", 0);

  const result = applyGatewayCost(message, 2.5);

  assert.equal(result.exact, true);
  assert.deepEqual(result.message.usage.cost, {
    input: 0,
    output: 2.5,
    cacheRead: 0,
    cacheWrite: 0,
    total: 2.5,
  });
  assert.deepEqual(message.usage.cost, {
    input: 1,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
});

test("parses only the key budget window fields", () => {
  assert.deepEqual(
    parseKeyWindow({
      info: {
        budget_reset_at: "2026-11-01T00:00:00+00:00",
        budget_duration: "30d",
        spend: 91.25,
        max_budget: 200,
        key_alias: "test-alias",
      },
    }),
    { resetAt: "2026-11-01T00:00:00+00:00", window: "30d" },
  );
  assert.deepEqual(parseKeyWindow({ info: { budget_reset_at: 123, budget_duration: null } }), {});
  assert.deepEqual(parseKeyWindow(null), {});
});

test("loads a key window with manual redirects and treats a 403 as unavailable", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/key/info");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    return new Response("forbidden", { status: 403 });
  };

  assert.deepEqual(await loadKeyWindow(cfg, apiKey, fetchImpl), {});
});

test("loads only reset time and duration from a fake key-info response", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/key/info");
    assert.equal(init?.redirect, "manual");
    return new Response(
      JSON.stringify({
        info: {
          budget_reset_at: "2026-11-01T00:00:00+00:00",
          budget_duration: "30d",
          spend: 91.25,
          max_budget: 200,
          key_alias: "test-alias",
        },
      }),
      { status: 200 },
    );
  };

  assert.deepEqual(await loadKeyWindow(cfg, apiKey, fetchImpl), {
    resetAt: "2026-11-01T00:00:00+00:00",
    window: "30d",
  });
});

test("turn_start clears orphaned stream and key-spend data before the next assistant message", () => {
  const runtime = fakeRuntime();
  const state = newHubState();
  state.activeModelId = "test-model";
  const { ctx, statuses } = fakeContext();
  registerSpend(runtime.pi as any, state, { config: cfg, apiKey, fetchImpl: async () => new Response("{}") });

  runtime.handlers.get("provider_stream_event")?.[0](
    {
      provider: "litellm",
      api: "openai-responses",
      model: "test-model",
      data: { type: "response.completed", response: { usage: { cost: 0.01 } } },
    },
    ctx,
  );
  runtime.handlers.get("after_provider_response")?.[0](
    { headers: { "x-litellm-key-spend": "74.70" } },
    ctx,
  );
  runtime.handlers.get("turn_start")?.[0]({}, ctx);

  const message = assistantMessage("openai-responses", 0.05);
  const result = runtime.handlers.get("message_end")?.[0]({ message }, ctx);

  assert.equal(result, undefined);
  assert.equal(state.sessionCost, 0.05);
  assert.equal(state.sessionEstimated, true);
  assert.equal(state.keySpend, undefined);
  assert.match(statuses.at(-1)?.text ?? "", /session ~\$0\.05 \(est\.\)/);
});

test("uses exact stream cost when the assistant message has no usage cost", () => {
  const runtime = fakeRuntime();
  const state = newHubState();
  state.activeModelId = "test-model";
  const { ctx, statuses } = fakeContext();
  registerSpend(runtime.pi as any, state, { config: cfg, apiKey, fetchImpl: async () => new Response("{}") });

  runtime.handlers.get("provider_stream_event")?.[0](
    {
      provider: "litellm",
      api: "openai-responses",
      model: "test-model",
      data: { type: "response.completed", response: { usage: { cost: 0.01 } } },
    },
    ctx,
  );
  runtime.handlers.get("after_provider_response")?.[0](
    { headers: { "x-litellm-key-spend": "74.70" } },
    ctx,
  );

  const message = assistantMessage("openai-responses", 4);
  const { cost: _cost, ...usage } = message.usage;
  const messageWithoutCost = { ...message, usage };
  const original = structuredClone(messageWithoutCost);
  const result = runtime.handlers.get("message_end")?.[0]({ message: messageWithoutCost }, ctx) as {
    message: ReturnType<typeof assistantMessage>;
  };

  assert.deepEqual(result.message.usage.cost, {
    input: 0,
    output: 0.01,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.01,
  });
  assert.deepEqual(messageWithoutCost, original);
  assert.equal("cost" in messageWithoutCost.usage, false);
  assert.equal(state.sessionCost, 0.01);
  assert.equal(state.sessionEstimated, false);
  assert.ok(Math.abs((state.keySpend ?? 0) - 74.71) < 1e-12);
  assert.match(statuses.at(-1)?.text ?? "", /session \$0\.01/);
});

test("a Claude estimate stays marked when a later GPT turn has exact cost", () => {
  const runtime = fakeRuntime();
  const state = newHubState();
  state.activeModelId = "test-model";
  const { ctx: claudeContext, statuses: claudeStatuses } = fakeContext("litellm", "anthropic-messages");
  const { ctx: gptContext, statuses: gptStatuses } = fakeContext("litellm", "openai-responses");
  registerSpend(runtime.pi as any, state, { config: cfg, apiKey, fetchImpl: async () => new Response("{}") });

  runtime.handlers.get("message_end")?.[0]({ message: assistantMessage("anthropic-messages", 0.05) }, claudeContext);

  assert.equal(state.sessionEstimated, true);
  assert.equal(state.sessionCost, 0.05);
  assert.match(claudeStatuses.at(-1)?.text ?? "", /session ~\$0\.05 \(est\.\)/);

  runtime.handlers.get("provider_stream_event")?.[0](
    {
      provider: "litellm",
      api: "openai-responses",
      model: "test-model",
      data: { type: "response.completed", response: { usage: { cost: 0.03 } } },
    },
    gptContext,
  );
  runtime.handlers.get("after_provider_response")?.[0](
    { headers: { "x-litellm-key-spend": "74.70" } },
    gptContext,
  );
  const gptMessage = assistantMessage("openai-responses", 4);
  const result = runtime.handlers.get("message_end")?.[0]({ message: gptMessage }, gptContext) as {
    message: ReturnType<typeof assistantMessage>;
  };

  assert.equal(result.message.usage.cost.total, 0.03);
  assert.equal(result.message.usage.cost.input, 0.0075);
  assert.equal(result.message.usage.cost.output, 0.0225);
  assert.equal(gptMessage.usage.cost.total, 4);
  assert.equal(state.sessionEstimated, true);
  assert.ok(Math.abs(state.sessionCost - 0.08) < 1e-12);
  assert.equal(state.keySpend, 74.73);
  assert.match(gptStatuses.at(-1)?.text ?? "", /session ~\$0\.08 \(est\.\)/);

  runtime.handlers.get("message_end")?.[0](
    { message: assistantMessage("openai-responses", 0.05) },
    gptContext,
  );
  assert.ok(Math.abs(state.sessionCost - 0.13) < 1e-12);
  assert.equal(state.keySpend, 74.73);
});

test("session start loads the key window once without blocking and stores no other metadata", async () => {
  const runtime = fakeRuntime();
  const state = newHubState();
  state.activeModelId = "test-model";
  state.keySpend = 74.7;
  const { ctx, statuses } = fakeContext();
  let fetchCalls = 0;
  let resolveFetch!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const fetchImpl: typeof fetch = () => {
    fetchCalls += 1;
    return pendingResponse;
  };
  registerSpend(runtime.pi as any, state, { config: cfg, apiKey, fetchImpl });

  const sessionStart = runtime.handlers.get("session_start")?.[0];
  assert.equal(sessionStart?.({}, ctx), undefined);
  assert.equal(fetchCalls, 1);
  assert.equal(state.resetAt, undefined);

  resolveFetch(
    new Response(
      JSON.stringify({
        info: {
          budget_reset_at: "2026-11-01T00:00:00+00:00",
          budget_duration: "30d",
          spend: 91.25,
          max_budget: 200,
          key_alias: "test-alias",
        },
      }),
      { status: 200 },
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(state.resetAt, "2026-11-01T00:00:00+00:00");
  assert.equal(state.window, "30d");
  assert.equal(state.keySpend, 74.7);
  assert.equal(state.keyBudget, undefined);
  assert.equal("key_alias" in state, false);
  assert.equal(fetchCalls, 1);
  assert.match(statuses.at(-1)?.text ?? "", /resets Nov 1/);

  sessionStart?.({}, ctx);
  assert.equal(fetchCalls, 1);
});

test("non-LiteLLM provider events do not change spend state", () => {
  const runtime = fakeRuntime();
  const state = newHubState();
  const before = structuredClone(state);
  const { ctx } = fakeContext("openai", "openai-completions");
  const statuses: unknown[] = [];
  ctx.ui.setStatus = (...args: [string, string | undefined]) => statuses.push(args);
  registerSpend(runtime.pi as any, state, { config: cfg, apiKey, fetchImpl: async () => new Response("{}") });

  runtime.handlers.get("provider_stream_event")?.[0](
    {
      provider: "openai",
      api: "openai-completions",
      model: "test-model",
      data: { usage: { cost: 3 } },
    },
    ctx,
  );
  runtime.handlers.get("after_provider_response")?.[0](
    { headers: { "x-litellm-key-spend": "99.00" } },
    ctx,
  );
  runtime.handlers.get("message_end")?.[0]({ message: { ...assistantMessage("openai-completions", 1), provider: "openai" } }, ctx);

  assert.deepEqual(state, before);
  assert.deepEqual(statuses, []);
});
