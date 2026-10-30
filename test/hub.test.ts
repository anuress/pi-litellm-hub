import assert from "node:assert/strict";
import test from "node:test";
import { createHub } from "../extensions/hub.ts";
import type { Catalog } from "../extensions/models.ts";

const fakeKey = ["sk", "abcdefgh12"].join("-");
const baseUrl = "https://litellm.example.com";
const env = { LITELLM_BASE_URL: baseUrl, LITELLM_API_KEY: fakeKey };

function catalogModel(id: string, api: string, provider: string) {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://foreign.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

const catalog: Catalog = {
  providers: () => ["openai", "anthropic"],
  models: (provider) => {
    if (provider === "openai") return [catalogModel("chat-model", "openai-responses", provider)];
    if (provider === "anthropic") return [catalogModel("claude-model", "anthropic-messages", provider)];
    return [];
  },
};

function responseFor(ids: string[], status = 200, body?: string): Response {
  return new Response(body ?? JSON.stringify({ data: ids.map((id) => ({ id })) }), { status });
}

function composeModelBaseUrl(providerConfig: any, modelId: string): string {
  const definition = providerConfig.models.find((model: any) => model.id === modelId);
  assert.ok(definition);
  return definition.baseUrl ?? providerConfig.baseUrl;
}

function fakeRuntime() {
  const providers: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  type Handler = (event: any, ctx: any) => any;
  type SharedHandler = (data: unknown) => void;
  const events = new Map<string, Handler>();
  const eventRegistrations = new Map<string, Handler[]>();
  const sharedEvents = new Map<string, Set<SharedHandler>>();
  const pi = {
    events: {
      emit: (channel: string, data: unknown) => {
        for (const handler of sharedEvents.get(channel) ?? []) handler(data);
      },
      on: (channel: string, handler: SharedHandler) => {
        const handlers = sharedEvents.get(channel) ?? new Set<SharedHandler>();
        handlers.add(handler);
        sharedEvents.set(channel, handlers);
        return () => handlers.delete(handler);
      },
    },
    registerProvider: (name: string, config: any) => providers.push({ name, config }),
    registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> | void }) =>
      commands.set(name, definition.handler),
    on: (event: string, handler: Handler) => {
      const registrations = eventRegistrations.get(event) ?? [];
      registrations.push(handler);
      eventRegistrations.set(event, registrations);
      events.set(event, (value, ctx) => {
        let result: any;
        for (const registration of registrations) {
          const next = registration(value, ctx);
          if (next !== undefined) result = next;
        }
        return result;
      });
      return () => events.delete(event);
    },
  };
  return { pi, providers, commands, events, eventRegistrations, sharedEvents };
}

function fakeContext() {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: true,
    model: undefined,
    thinkingLevel: undefined,
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  };
  return { ctx, statuses, notifications };
}

function dependencies(
  pi: any,
  fetchImpl: typeof fetch,
  options: {
    env?: Record<string, string | undefined>;
    resolveKey?: (ref: string, env: Record<string, string | undefined>) => string | undefined;
  } = {},
) {
  return {
    pi,
    env: options.env ?? env,
    home: ".nonexistent-hub-test-home",
    fetchImpl,
    catalog,
    resolveKey: options.resolveKey ?? ((ref, values) => {
      assert.equal(ref, "$LITELLM_API_KEY");
      return values.LITELLM_API_KEY;
    }),
  };
}

test("an unconfigured hub answers state requests with configured false", async () => {
  const runtime = fakeRuntime();
  let fetched = false;
  const fetchImpl: typeof fetch = async () => {
    fetched = true;
    return responseFor([]);
  };
  const state = await createHub(dependencies(runtime.pi, fetchImpl, { env: {} }));
  const { ctx, statuses } = fakeContext();

  await runtime.events.get("session_start")?.({}, ctx);

  assert.equal(state.notConfigured, "no gateway URL");
  assert.equal(runtime.providers.length, 0);
  assert.equal(fetched, false);
  assert.equal(statuses.at(-1)?.text, "litellm · not configured: no gateway URL");
  const snapshots: Array<{ configured: boolean; reason?: string }> = [];
  runtime.pi.events.on("litellm-hub:state", (snapshot) => snapshots.push(snapshot as typeof snapshots[number]));
  runtime.pi.events.emit("litellm-hub:request", undefined);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].configured, false);
  assert.equal(snapshots[0].reason, "no gateway URL");
});

test("configured startup registers reference auth and only same-gateway model URLs", async () => {
  const runtime = fakeRuntime();
  const fetchImpl: typeof fetch = async () => responseFor(["chat-model", "claude-model"]);
  const state = await createHub(dependencies(runtime.pi, fetchImpl));
  const registration = runtime.providers[0];

  assert.equal(state.models.length, 2);
  assert.equal(runtime.providers.length, 1);
  assert.equal(registration.name, "litellm");
  assert.equal(registration.config.baseUrl, `${baseUrl}/v1`);
  assert.equal(registration.config.apiKey, "$LITELLM_API_KEY");
  const openAiModel = registration.config.models.find((model: any) => model.id === "chat-model");
  const anthropicModel = registration.config.models.find((model: any) => model.id === "claude-model");
  assert.equal("baseUrl" in openAiModel, false);
  assert.equal(anthropicModel.baseUrl, baseUrl);
  assert.equal(composeModelBaseUrl(registration.config, "claude-model"), baseUrl);
  assert.equal(composeModelBaseUrl(registration.config, "chat-model"), `${baseUrl}/v1`);
  assert.equal(registration.config.models.some((model: any) => model.baseUrl === "https://foreign.example/v1"), false);
});

test("offline provider refresh reuses loaded models without fetching or changing the reason", async () => {
  const runtime = fakeRuntime();
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return responseFor(["chat-model", "claude-model"]);
  };
  const state = await createHub(dependencies(runtime.pi, fetchImpl));
  const registration = runtime.providers[0].config;
  const refreshModels = registration.refreshModels;
  state.reason = "keep this reason";
  const callsBeforeRefresh = fetchCalls;

  const refreshed = await refreshModels({ allowNetwork: false, signal: new AbortController().signal });
  const offlineRegistration = { ...registration, models: refreshed };

  assert.equal(fetchCalls - callsBeforeRefresh, 0);
  assert.deepEqual(refreshed, registration.models);
  assert.equal(refreshed.find((model: any) => model.id === "claude-model")?.baseUrl, baseUrl);
  assert.equal(composeModelBaseUrl(offlineRegistration, "claude-model"), baseUrl);
  assert.equal(composeModelBaseUrl(offlineRegistration, "chat-model"), `${baseUrl}/v1`);
  assert.equal(state.reason, "keep this reason");
});

test("online provider refresh fetches the catalog once", async () => {
  const runtime = fakeRuntime();
  let fetchCalls = 0;
  let ids = ["chat-model"];
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return responseFor(ids);
  };
  const state = await createHub(dependencies(runtime.pi, fetchImpl));
  const refreshModels = runtime.providers[0].config.refreshModels;
  ids = ["claude-model"];
  fetchCalls = 0;

  const refreshed = await refreshModels({ allowNetwork: true, signal: new AbortController().signal });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(refreshed.map((model: any) => model.id), ["claude-model"]);
  assert.equal(state.models[0].id, "claude-model");
});

test("startup plus pi offline refresh makes one gateway request total", async () => {
  const runtime = fakeRuntime();
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    fetchCalls += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(new URL(url).pathname, "/v1/models");
    return responseFor(["chat-model"]);
  };
  await createHub(dependencies(runtime.pi, fetchImpl));

  assert.equal(fetchCalls, 1);
  await runtime.providers[0].config.refreshModels({
    allowNetwork: false,
    signal: new AbortController().signal,
  });
  assert.equal(fetchCalls, 1);
});

test("a gateway failure does not throw, register models, or expose its key in status", async () => {
  const runtime = fakeRuntime();
  const fetchImpl: typeof fetch = async () => responseFor([], 503, `gateway rejected ${fakeKey}`);
  const state = await createHub(dependencies(runtime.pi, fetchImpl));
  const { ctx, statuses } = fakeContext();

  await runtime.events.get("session_start")?.({}, ctx);

  assert.equal(runtime.providers.length, 0);
  assert.equal(state.reason?.includes(fakeKey), false);
  assert.match(statuses.at(-1)?.text ?? "", /gateway \/v1\/models returned 503/);
  assert.equal(statuses.at(-1)?.text?.includes(fakeKey), false);
});

test("refresh re-registers the expanded catalog and reports the new count", async () => {
  const runtime = fakeRuntime();
  let ids = ["chat-model"];
  const fetchImpl: typeof fetch = async () => responseFor(ids);
  const state = await createHub(dependencies(runtime.pi, fetchImpl));
  const { ctx, notifications } = fakeContext();
  ids = ["chat-model", "claude-model"];

  await runtime.commands.get("litellm")?.("refresh", ctx);

  assert.equal(state.models.length, 2);
  assert.equal(runtime.providers.length, 2);
  assert.equal(runtime.providers[1].config.models.length, 2);
  assert.equal(notifications.at(-1)?.message, "refreshed: 2 models");
});

test("a failed refresh retains the prior catalog and redacts its notification", async () => {
  const runtime = fakeRuntime();
  let fail = false;
  const fetchImpl: typeof fetch = async () =>
    fail ? responseFor([], 502, `upstream error ${fakeKey}`) : responseFor(["chat-model"]);
  const state = await createHub(dependencies(runtime.pi, fetchImpl));
  const { ctx, notifications } = fakeContext();
  fail = true;

  await runtime.commands.get("litellm")?.("refresh", ctx);

  assert.equal(state.models.length, 1);
  assert.equal(runtime.providers.length, 1);
  assert.match(notifications.at(-1)?.message ?? "", /refresh failed: gateway \/v1\/models returned 502/);
  assert.equal(notifications.at(-1)?.message.includes(fakeKey), false);
});

test("the report command includes catalog details and the latest Claude cache usage", async () => {
  const runtime = fakeRuntime();
  const fetchImpl: typeof fetch = async () => responseFor(["chat-model", "text-embedding-model"]);
  await createHub(dependencies(runtime.pi, fetchImpl));
  const { ctx, notifications } = fakeContext();
  const claudeCtx = {
    ...ctx,
    model: { provider: "litellm", api: "anthropic-messages", id: "claude-model" },
  };

  runtime.events.get("message_end")?.(
    {
      message: {
        role: "assistant",
        provider: "litellm",
        api: "anthropic-messages",
        usage: { cacheRead: 10278, cacheWrite: 0 },
      },
    },
    claudeCtx,
  );
  await runtime.commands.get("litellm")?.("", ctx);

  assert.match(notifications.at(-1)?.message ?? "", /1 matched, 1 skipped/);
  assert.match(notifications.at(-1)?.message ?? "", /chat-model \| openai-responses \| off, minimal, low, medium, high \(pi default\) \| openai/);
  assert.match(notifications.at(-1)?.message ?? "", /Last Claude cache: cache: hit \(read 10\.3k\)/);
  assert.match(notifications.at(-1)?.message ?? "", /text-embedding-model — not a chat model/);
});

test("hub notifications redact the gateway host", async () => {
  const runtime = fakeRuntime();
  const state = await createHub(dependencies(runtime.pi, async () => responseFor(["chat-model"])));
  state.skipped.push({ id: "unavailable-model", reason: "upstream at LITELLM.EXAMPLE.COM unavailable" });
  const { ctx, notifications } = fakeContext();

  await runtime.commands.get("litellm")?.("", ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message.includes("litellm.example.com"), false);
  assert.match(notifications[0].message, /<gateway>/);
});

test("state requests publish the current allowlisted, redacted snapshot", async () => {
  const runtime = fakeRuntime();
  const state = await createHub(dependencies(runtime.pi, async () => responseFor(["chat-model"])));
  state.activeModelId = "chat-model";
  state.thinking = "high";
  state.reason = `request failed at LITELLM.EXAMPLE.COM with ${fakeKey}`;
  const snapshots: unknown[] = [];
  runtime.pi.events.on("litellm-hub:state", (snapshot) => snapshots.push(snapshot));

  runtime.pi.events.emit("litellm-hub:request", undefined);

  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "at",
    "attemptedFallbacks",
    "attemptedRetries",
    "configured",
    "keyBudget",
    "keySpend",
    "lastCache",
    "levelsAvailable",
    "model",
    "modelsMatched",
    "modelsSkipped",
    "reason",
    "resetAt",
    "sessionCost",
    "sessionEstimated",
    "thinkingLevel",
    "window",
  ]);
  assert.equal(snapshot.model, "chat-model");
  assert.equal(snapshot.reason, "request failed at <gateway> with sk-***");
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(fakeKey), false);
  assert.equal(serialized.includes("litellm.example.com"), false);
});

test("model and thinking selection events keep the status current", async () => {
  const runtime = fakeRuntime();
  const fetchImpl: typeof fetch = async () => responseFor(["chat-model"]);
  const state = await createHub(dependencies(runtime.pi, fetchImpl));
  const { ctx, statuses } = fakeContext();
  const selecting = { ...ctx, thinkingLevel: "medium" };

  await runtime.events.get("model_select")?.(
    { model: { provider: "litellm", id: "chat-model" } },
    selecting,
  );
  assert.equal(state.activeModelId, "chat-model");
  assert.equal(state.thinking, "medium");
  assert.match(statuses.at(-1)?.text ?? "", /thinking medium/);

  await runtime.events.get("thinking_level_select")?.({ level: "off" }, { ...ctx, thinkingLevel: "off" });
  assert.equal(state.thinking, "off");
  assert.match(statuses.at(-1)?.text ?? "", /thinking off/);
});

test("Claude cache markers pass through the hub request hook by reference", async () => {
  const runtime = fakeRuntime();
  await createHub(dependencies(runtime.pi, async () => responseFor(["claude-model"])));
  const payload = {
    system: [{ type: "text", text: "Rules", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] }],
  };
  const original = structuredClone(payload);
  const ctx = {
    ...fakeContext().ctx,
    model: { provider: "litellm", api: "anthropic-messages", id: "claude-model" },
  };
  const beforeRequest = runtime.events.get("before_provider_request");

  const result = beforeRequest?.({ payload }, ctx);

  assert.equal(result, payload);
  assert.deepEqual(payload, original);
});

test("configured hub wires transport, Claude cache, and error observation", async () => {
  const runtime = fakeRuntime();
  await createHub(dependencies(runtime.pi, async () => responseFor(["chat-model", "claude-model"])));

  for (const event of ["provider_stream_event", "before_provider_request"]) {
    assert.equal(runtime.eventRegistrations.get(event)?.length, 1, `${event} handler is registered`);
  }
  assert.equal(runtime.eventRegistrations.get("before_provider_headers")?.length, 2);
  assert.equal(runtime.eventRegistrations.get("after_provider_response")?.length, 3);
  assert.equal(runtime.eventRegistrations.get("message_end")?.length, 3);
  assert.equal(runtime.eventRegistrations.get("session_start")?.length, 2);
});
