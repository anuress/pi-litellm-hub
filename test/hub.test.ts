import assert from "node:assert/strict";
import test from "node:test";
import { createHub } from "../extensions/hub.ts";
import type { Catalog } from "../extensions/models.ts";

const fakeKey = ["fake", "gateway", "secret"].join("-");
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

function fakeRuntime() {
  const providers: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  const events = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const pi = {
    registerProvider: (name: string, config: any) => providers.push({ name, config }),
    registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> | void }) =>
      commands.set(name, definition.handler),
    on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
      events.set(event, handler);
      return () => events.delete(event);
    },
  };
  return { pi, providers, commands, events };
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

test("an unconfigured hub never registers a provider and shows its status", async () => {
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
  assert.equal(registration.config.models.some((model: any) => model.baseUrl === "https://foreign.example/v1"), false);
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

test("the report command notifies with the matched catalog details", async () => {
  const runtime = fakeRuntime();
  const fetchImpl: typeof fetch = async () => responseFor(["chat-model", "text-embedding-model"]);
  await createHub(dependencies(runtime.pi, fetchImpl));
  const { ctx, notifications } = fakeContext();

  await runtime.commands.get("litellm")?.("", ctx);

  assert.match(notifications.at(-1)?.message ?? "", /1 matched, 1 skipped/);
  assert.match(notifications.at(-1)?.message ?? "", /chat-model \| openai-responses \| pi default \| openai/);
  assert.match(notifications.at(-1)?.message ?? "", /text-embedding-model — not a chat model/);
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
