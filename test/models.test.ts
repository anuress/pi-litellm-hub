import assert from "node:assert/strict";
import test from "node:test";
import packageInfo from "../package.json" with { type: "json" };
import { fetchGatewayModels, matchModels, type Catalog } from "../extensions/models.ts";

const fakeApiKey = ["sk", "abcdefgh12"].join("-");

const efforts = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

type FakeEntry = { provider: string; model: Record<string, any> };

function fakeCatalog(entries: FakeEntry[]): Catalog {
  const providers = [...new Set(entries.map((entry) => entry.provider))];
  return {
    providers: () => providers,
    models: (provider) => entries.filter((entry) => entry.provider === provider).map((entry) => entry.model),
  };
}

function catalogModel(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://litellm.example.com/v1",
    reasoning: true,
    thinkingLevelMap: efforts,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 32768,
    ...overrides,
  };
}

test("matches an exact catalog id and preserves its effort map and provider source", () => {
  const result = matchModels(
    ["gpt-6-luna"],
    fakeCatalog([
      { provider: "openai", model: catalogModel() },
      {
        provider: "azure-openai-responses",
        model: catalogModel({ api: "azure-openai-responses", thinkingLevelMap: { high: "azure" } }),
      },
      { provider: "opencode", model: catalogModel({ thinkingLevelMap: { high: "opencode" } }) },
    ]),
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(result.models[0], {
    id: "gpt-6-luna",
    api: "openai-responses",
    catalogSource: "openai",
    levels: efforts,
    priceSources: { input: "pi catalog", output: "pi catalog", cacheRead: "pi catalog", cacheWrite: "pi catalog" },
    model: {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      api: "openai-responses",
      reasoning: true,
      thinkingLevelMap: efforts,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 32768,
    },
  });
  assert.equal(result.models[0].reason, undefined);
});

test("matches a vendor-prefixed id to its vendor provider", () => {
  const result = matchModels(
    ["moonshotai/kimi-k3"],
    fakeCatalog([
      {
        provider: "openrouter",
        model: catalogModel({ id: "kimi-k3", thinkingLevelMap: { high: "aggregator" } }),
      },
      { provider: "nvidia", model: catalogModel({ id: "kimi-k3", thinkingLevelMap: { high: "nvidia" } }) },
      {
        provider: "moonshotai",
        model: catalogModel({
          id: "kimi-k3",
          name: "Kimi K3",
          api: "openai-completions",
          compat: { thinkingFormat: "openrouter" },
        }),
      },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "moonshotai");
  assert.equal(result.models[0].model.id, "moonshotai/kimi-k3");
  assert.deepEqual(result.models[0].levels, efforts);
});

test("explains Kimi thinking without a model-specific carrier", () => {
  const result = matchModels(
    ["moonshotai/kimi-k3"],
    fakeCatalog([
      {
        provider: "moonshotai",
        model: catalogModel({ id: "kimi-k3", api: "openai-completions" }),
      },
    ]),
  );

  assert.equal(result.models[0].reason, "kimi needs its own thinking switch");
  assert.equal(result.models[0].levels, undefined);
  assert.equal("thinkingLevelMap" in result.models[0].model, false);
});

test("reports ambiguity when same-priority entries have different effort maps", () => {
  const result = matchModels(
    ["glm-5.3"],
    fakeCatalog([
      { provider: "openai", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { high: "high" } }) },
      { provider: "openai", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { high: "on" } }) },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "openai");
  assert.equal(result.models[0].reason, "ambiguous catalog match");
  assert.equal(result.models[0].levels, undefined);
  assert.equal("thinkingLevelMap" in result.models[0].model, false);
});

test("matches identical same-priority effort maps independent of property order", () => {
  const result = matchModels(
    ["glm-5.3"],
    fakeCatalog([
      { provider: "openai", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { low: "low", high: "high" } }) },
      { provider: "openai", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { high: "high", low: "low" } }) },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "openai");
  assert.equal(result.models[0].reason, undefined);
  assert.deepEqual(result.models[0].levels, { low: "low", high: "high" });
});

test("uses a safe completion fallback and a reason for unknown chat ids", () => {
  const id = "auto-router-coding-llm-lite";
  const result = matchModels([id], fakeCatalog([]));

  assert.deepEqual(result.models[0], {
    id,
    api: "openai-completions",
    priceSources: { input: "default", output: "default", cacheRead: "default", cacheWrite: "default" },
    reason: "not in pi's catalog",
    model: {
      type: "chat",
      id,
      name: id,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    },
  });
});

test("uses gateway input limits conservatively and keeps catalog output limits", () => {
  const result = matchModels(
    ["gpt-6-luna", "gpt-5-mini", "z-ai/glm-5.3", "no-limits"],
    fakeCatalog([
      { provider: "openai", model: catalogModel() },
      { provider: "openai", model: catalogModel({ id: "gpt-5-mini", contextWindow: 400000, maxTokens: 128000 }) },
    ]),
    [
      { id: "gpt-6-luna", maxInputTokens: 922000, maxOutputTokens: 8192 },
      { id: "gpt-5-mini", maxInputTokens: 272000, maxOutputTokens: 8192 },
      { id: "z-ai/glm-5.3", maxInputTokens: 200000, maxOutputTokens: 32000 },
      { id: "no-limits", mode: "chat" },
    ],
  );

  const limits = Object.fromEntries(
    result.models.map(({ id, model }) => [id, [model.contextWindow, model.maxTokens]]),
  );
  assert.deepEqual(limits, {
    "gpt-6-luna": [256000, 32768],
    "gpt-5-mini": [272000, 128000],
    "z-ai/glm-5.3": [200000, 32000],
    "no-limits": [128000, 16384],
  });
});

test("keeps the first gateway record when trimmed IDs are duplicated", () => {
  const result = matchModels(
    [" chat-model ", "chat-model"],
    fakeCatalog([]),
    [
      { id: " chat-model ", mode: "chat", maxInputTokens: 64000, maxOutputTokens: 2048 },
      { id: "chat-model", mode: "embedding", maxInputTokens: 4096, maxOutputTokens: 1024 },
    ],
  );

  assert.deepEqual(
    result.models.map(({ id, model }) => [id, model.contextWindow, model.maxTokens]),
    [["chat-model", 64000, 2048]],
  );
  assert.deepEqual(result.skipped, []);
});

test("uses gateway mode and falls back to ID filters only when mode is absent", () => {
  const result = matchModels(
    ["gpt-6-luna", "image-model", "chat-model", "text-embedding-3-small"],
    fakeCatalog([{ provider: "openai", model: catalogModel() }]),
    [
      { id: "gpt-6-luna", mode: "image_generation" },
      { id: "image-model", mode: "responses" },
      { id: "chat-model", mode: "chat" },
    ],
  );

  assert.deepEqual(result.models.map(({ id }) => id), ["image-model", "chat-model"]);
  assert.deepEqual(result.skipped, [
    { id: "gpt-6-luna", reason: "not a chat model" },
    { id: "text-embedding-3-small", reason: "not a chat model" },
  ]);
});

test("skips known non-chat ids that have no catalog match", () => {
  const ids = [
    "text-embedding-3-small",
    "voyage/voyage-3-large",
    "cohere/rerank-v3.5",
    "vertex_ai/chirp_3",
    "gpt-image-2.5-flare",
  ];
  const result = matchModels(ids, fakeCatalog([]));

  assert.deepEqual(result.models, []);
  assert.deepEqual(result.skipped, ids.map((id) => ({ id, reason: "not a chat model" })));
});

test("skips a catalog entry whose declared type is not chat", () => {
  const result = matchModels(
    ["image-model"],
    fakeCatalog([
      { provider: "images", model: catalogModel({ id: "image-model", type: "image" }) },
    ]),
  );

  assert.deepEqual(result.models, []);
  assert.deepEqual(result.skipped, [{ id: "image-model", reason: "not a chat model" }]);
});

test("removes catalog provider and base URL fields from every model config", () => {
  const result = matchModels(
    ["gpt-6-luna", "unknown-chat"],
    fakeCatalog([{ provider: "openai", model: catalogModel() }]),
  );

  for (const model of result.models) {
    assert.equal("baseUrl" in model.model, false);
    assert.equal("provider" in model.model, false);
  }
});

test("normalizes Azure Responses and falls back for unsupported catalog APIs", () => {
  const result = matchModels(
    ["azure-model", "unsupported-model"],
    fakeCatalog([
      { provider: "azure", model: catalogModel({ id: "azure-model", api: "azure-openai-responses" }) },
      { provider: "other", model: catalogModel({ id: "unsupported-model", api: "google-generative-ai" }) },
    ]),
  );

  assert.equal(result.models[0].api, "openai-responses");
  assert.equal(result.models[0].model.api, "openai-responses");
  assert.equal(result.models[1].api, "openai-completions");
});

test("rejects HTTP and opaque gateway redirects", async () => {
  const cfg = {
    baseUrl: "https://litellm.example.com",
    apiKeyRef: "$LITELLM_API_KEY",
    claudeCacheWarming: false,
  };
  const responses = [new Response("", { status: 302 }), { status: 0, type: "opaqueredirect" } as Response];
  for (const response of responses) {
    const fetchImpl: typeof fetch = async () => response;
    await assert.rejects(fetchGatewayModels(cfg, fakeApiKey, fetchImpl), /redirect refused \(3xx\)/);
  }
});

test("redacts the API key from a gateway error body", async () => {
  const apiKey = fakeApiKey;
  const fetchImpl: typeof fetch = async () =>
    new Response(`gateway rejected ${apiKey}`, { status: 403 });

  await assert.rejects(
    fetchGatewayModels(
      { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY", claudeCacheWarming: false },
      apiKey,
      fetchImpl,
    ),
    (error: Error) => {
      assert.match(error.message, /gateway \/v1\/models returned 403/);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );
});

test("fetches gateway model metadata with manual redirects and the package user agent", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ data: [
      { id: "one", mode: "chat", max_input_tokens: 922000, max_output_tokens: 128000 },
      { id: "two", mode: null, max_input_tokens: 0, max_output_tokens: "big" },
      { id: "three", mode: 4, max_input_tokens: 3.5, max_output_tokens: -1 },
      { id: "four", max_input_tokens: "many", max_output_tokens: 3.5 },
      { id: 4 },
    ] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const listed = await fetchGatewayModels(
    { baseUrl: "https://litellm.example.com/", apiKeyRef: "$LITELLM_API_KEY", claudeCacheWarming: false },
    fakeApiKey,
    fetchImpl,
  );

  assert.deepEqual(listed, [
    { id: "one", mode: "chat", maxInputTokens: 922000, maxOutputTokens: 128000 },
    { id: "two" },
    { id: "three" },
    { id: "four" },
  ]);
  assert.equal(requestUrl, "https://litellm.example.com/v1/models");
  assert.equal(requestInit?.method, "GET");
  assert.equal(requestInit?.redirect, "manual");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${fakeApiKey}`);
  assert.equal(headers.get("user-agent"), `pi-litellm-hub/${packageInfo.version}`);
});

test("rejects a successful response without the documented data list", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ models: [{ id: fakeApiKey }] }), { status: 200 });

  await assert.rejects(
    fetchGatewayModels(
      { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY", claudeCacheWarming: false },
      fakeApiKey,
      fetchImpl,
    ),
    /invalid model list/,
  );
});

test("warms only Claude caches when enabled and preserves catalog lifetimes", () => {
  const catalogPromptCache = { short: 120, long: 900 };
  const inheritedPromptCache = { short: 999, long: 999 };
  const inheritedModel = Object.assign(
    Object.create({ promptCache: inheritedPromptCache }),
    catalogModel({ id: "claude-inherited", provider: "anthropic", api: "anthropic-messages" }),
  );
  const entries = [
    {
      provider: "anthropic",
      model: catalogModel({ id: "claude-default", provider: "anthropic", api: "anthropic-messages" }),
    },
    { provider: "anthropic", model: inheritedModel },
    {
      provider: "anthropic",
      model: catalogModel({
        id: "claude-custom",
        provider: "anthropic",
        api: "anthropic-messages",
        promptCache: catalogPromptCache,
      }),
    },
    { provider: "openai", model: catalogModel({ id: "gpt-model", promptCache: catalogPromptCache }) },
  ];
  const models = fakeCatalog(entries);
  const ids = ["claude-default", "claude-custom", "claude-inherited", "gpt-model"];
  const disabled = matchModels(ids, models);
  for (const { model } of disabled.models) assert.equal("promptCache" in model, false);

  const enabled = matchModels(ids, models, [], true);
  const byId = Object.fromEntries(enabled.models.map(({ id, model }) => [id, model]));
  assert.deepEqual(byId["claude-default"].promptCache, { short: 300, long: 3600 });
  assert.deepEqual(byId["claude-custom"].promptCache, catalogPromptCache);
  assert.deepEqual(byId["claude-inherited"].promptCache, { short: 300, long: 3600 });
  assert.equal("promptCache" in byId["gpt-model"], false);
});

test("keeps only model-intrinsic catalog compat and drops transport fields", () => {
  const lunaCompat = {
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsMidConvoSystemMessages: true,
    supportsExplicitPromptCacheMode: true,
    supportsMidConvoEffort: true,
  };
  const entry = (id: string, compat: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    provider: "p",
    model: catalogModel({ id, compat, promptCache: { mode: "explicit" }, headers: { a: "b" }, ...extra }),
  });
  const result = matchModels(
    ["sonnet", "opus", "luna", "kimi"],
    fakeCatalog([
      entry("sonnet", { forceAdaptiveThinking: true, supportsStrictTools: true }),
      entry("opus", {
        supportsMidConvoEffort: true,
        supportsMidConvoToolChanges: true,
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsStrictTools: true,
      }),
      entry("luna", lunaCompat),
      entry("kimi", { supportsDeveloperRole: false, thinkingFormat: "openrouter", sendSessionAffinityHeaders: true }),
    ]),
  );
  const [sonnet, opus, luna, kimi] = result.models.map((model) => model.model);

  assert.deepEqual(sonnet.compat, { forceAdaptiveThinking: true, supportsStrictTools: true });
  assert.deepEqual(opus.compat, { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true });
  assert.equal("compat" in luna, false);
  assert.equal("compat" in kimi, false);
  for (const model of [sonnet, opus, luna, kimi]) {
    assert.deepEqual(Object.keys(model).filter((key) => ["promptCache", "headers"].includes(key)), []);
    assert.deepEqual(model.thinkingLevelMap, efforts);
  }
});
