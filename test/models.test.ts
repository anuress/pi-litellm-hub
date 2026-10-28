import assert from "node:assert/strict";
import test from "node:test";
import packageInfo from "../package.json" with { type: "json" };
import { fetchGatewayIds, matchModels, type Catalog } from "../extensions/models.ts";

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
    fakeCatalog([{ provider: "openai", model: catalogModel() }]),
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(result.models[0], {
    id: "gpt-6-luna",
    api: "openai-responses",
    catalogSource: "openai",
    levels: efforts,
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

test("reports ambiguous matches only when their effort maps differ", () => {
  const result = matchModels(
    ["glm-5.3"],
    fakeCatalog([
      { provider: "zai", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { high: "high" } }) },
      { provider: "openrouter", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { high: "on" } }) },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "zai");
  assert.equal(result.models[0].reason, "ambiguous catalog match");
  assert.equal(result.models[0].levels, undefined);
  assert.equal("thinkingLevelMap" in result.models[0].model, false);
});

test("matches identical effort maps independent of property order", () => {
  const result = matchModels(
    ["glm-5.3"],
    fakeCatalog([
      { provider: "zai", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { low: "low", high: "high" } }) },
      { provider: "openrouter", model: catalogModel({ id: "glm-5.3", thinkingLevelMap: { high: "high", low: "low" } }) },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "zai");
  assert.equal(result.models[0].reason, undefined);
  assert.deepEqual(result.models[0].levels, { low: "low", high: "high" });
});

test("uses a safe completion fallback and a reason for unknown chat ids", () => {
  const id = "auto-router-coding-llm-lite";
  const result = matchModels([id], fakeCatalog([]));

  assert.deepEqual(result.models[0], {
    id,
    api: "openai-completions",
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

test("rejects gateway redirects", async () => {
  const fetchImpl: typeof fetch = async () => new Response("", { status: 302 });
  await assert.rejects(
    fetchGatewayIds(
      { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY", claudeCache: false },
      fakeApiKey,
      fetchImpl,
    ),
    /redirect refused \(3xx\)/,
  );
});

test("redacts the API key from a gateway error body", async () => {
  const apiKey = fakeApiKey;
  const fetchImpl: typeof fetch = async () =>
    new Response(`gateway rejected ${apiKey}`, { status: 403 });

  await assert.rejects(
    fetchGatewayIds(
      { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY", claudeCache: false },
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

test("fetches gateway model ids with manual redirects and the package user agent", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ data: [{ id: "one" }, { id: "two" }, { id: 4 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const ids = await fetchGatewayIds(
    { baseUrl: "https://litellm.example.com/", apiKeyRef: "$LITELLM_API_KEY", claudeCache: false },
    fakeApiKey,
    fetchImpl,
  );

  assert.deepEqual(ids, ["one", "two"]);
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
    fetchGatewayIds(
      { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY", claudeCache: false },
      fakeApiKey,
      fetchImpl,
    ),
    /invalid model list/,
  );
});

test("rejects opaque redirects from the gateway", async () => {
  const fetchImpl: typeof fetch = async () =>
    ({ status: 0, type: "opaqueredirect" }) as Response;
  await assert.rejects(
    fetchGatewayIds(
      { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY", claudeCache: false },
      fakeApiKey,
      fetchImpl,
    ),
    /redirect refused \(3xx\)/,
  );
});
