import assert from "node:assert/strict";
import test from "node:test";
import { discoverGatewayModels } from "../extensions/model-info.ts";
import type { GatewayModel } from "../extensions/gateway.ts";
import { matchModels, type Catalog } from "../extensions/models.ts";
import { newHubState, renderModelReport, renderStatus } from "../extensions/status.ts";

const config = { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY" };
const apiKey = ["sk", "abcdefgh12"].join("-");

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function routeFetcher(routes: Record<string, Response>, calls: string[]): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const response = routes[path];
    if (!response) throw new Error(`unexpected route ${path}`);
    return response;
  };
}

const catalog: Catalog = {
  providers: () => ["openai"],
  models: () => [{
    id: "known-model",
    name: "Known Model",
    api: "openai-responses",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    contextWindow: 128000,
    maxTokens: 8192,
  }],
};

test("uses model-group info first and converts all four prices to pi units", async () => {
  const calls: string[] = [];
  const result = await discoverGatewayModels(config, apiKey, routeFetcher({
    "/model_group/info": jsonResponse({ data: [{
      model_group: "known-model",
      mode: "chat",
      max_input_tokens: 64000,
      max_output_tokens: 2048,
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000003,
      cache_read_input_token_cost: 0.000004,
      cache_creation_input_token_cost: 0.000005,
    }] }),
  }, calls));

  assert.deepEqual(calls, ["/model_group/info"]);
  assert.deepEqual(result, {
    models: [{
      id: "known-model",
      mode: "chat",
      maxInputTokens: 64000,
      maxOutputTokens: 2048,
      prices: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
    }],
  });
  const matched = matchModels(["known-model"], catalog, result.models);
  const state = Object.assign(newHubState(), { models: matched.models });
  assert.match(renderModelReport(state), /prices: gateway/);
  assert.equal(renderStatus(state), "litellm · 1 models");
});

test("falls through a forbidden group route and conservatively merges model deployments", async () => {
  const calls: string[] = [];
  const result = await discoverGatewayModels(config, apiKey, routeFetcher({
    "/model_group/info": new Response("forbidden", { status: 403 }),
    "/model/info": jsonResponse({ data: [
      {
        model_name: "known-model",
        litellm_params: { model: "ignored-backend-name" },
        model_info: {
          mode: "chat",
          max_input_tokens: 128000,
          max_output_tokens: 2048,
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000005,
          cache_read_input_token_cost: 0.000003,
        },
      },
      {
        model_name: "known-model",
        litellm_params: { model: "another-ignored-backend" },
        model_info: {
          mode: "chat",
          max_input_tokens: 64000,
          max_output_tokens: 1024,
          input_cost_per_token: 0.000004,
          output_cost_per_token: 0.000002,
          cache_creation_input_token_cost: 0.000006,
        },
      },
    ] }),
  }, calls));

  assert.deepEqual(calls, ["/model_group/info", "/model/info"]);
  assert.deepEqual(result.models, [{
    id: "known-model",
    mode: "chat",
    maxInputTokens: 64000,
    maxOutputTokens: 1024,
    prices: { input: 4, output: 5, cacheRead: 3, cacheWrite: 6 },
  }]);
  assert.equal(result.priceFallbackReason, undefined);
});

test("falls back to v1 models when neither metadata route is readable", async () => {
  const calls: string[] = [];
  const result = await discoverGatewayModels(config, apiKey, routeFetcher({
    "/model_group/info": new Response("forbidden", { status: 403 }),
    "/model/info": new Response("forbidden", { status: 403 }),
    "/v1/models": jsonResponse({ data: [{ id: "legacy-model", mode: "chat" }] }),
  }, calls));

  assert.deepEqual(calls, ["/model_group/info", "/model/info", "/v1/models"]);
  assert.deepEqual(result.models, [{ id: "legacy-model", mode: "chat" }]);
  assert.equal(result.priceFallbackReason, "key can't read /model/info");
});

test("treats missing metadata routes as quiet fallbacks", async () => {
  const calls: string[] = [];
  const result = await discoverGatewayModels(config, apiKey, routeFetcher({
    "/model_group/info": new Response("route not found", { status: 404 }),
    "/model/info": new Response("route not found", { status: 404 }),
    "/v1/models": jsonResponse({ data: [{ id: "legacy-model" }] }),
  }, calls));

  assert.deepEqual(calls, ["/model_group/info", "/model/info", "/v1/models"]);
  assert.equal(result.priceFallbackReason, "gateway /model/info unavailable (404)");
});

test("keeps a server error as the catalog-price fallback reason", async () => {
  const calls: string[] = [];
  const result = await discoverGatewayModels(config, apiKey, routeFetcher({
    "/model_group/info": new Response("temporary gateway failure", { status: 500 }),
    "/model/info": new Response("forbidden", { status: 403 }),
    "/v1/models": jsonResponse({ data: [{ id: "legacy-model" }] }),
  }, calls));

  assert.deepEqual(calls, ["/model_group/info", "/model/info", "/v1/models"]);
  assert.equal(result.priceFallbackReason, "gateway /model_group/info returned 500");
  assert.equal(
    renderStatus(Object.assign(newHubState(), { priceFallbackReason: result.priceFallbackReason })),
    "litellm · 0 models · prices: pi catalog (gateway /model_group/info returned 500)",
  );
});

test("ignores garbage gateway fields and falls back per price field without changing limits", async () => {
  const calls: string[] = [];
  const result = await discoverGatewayModels(config, apiKey, routeFetcher({
    "/model_group/info": jsonResponse({ data: [
      {
        model_group: "known-model",
        mode: "chat",
        max_input_tokens: 64000,
        max_output_tokens: 3,
        input_cost_per_token: 0.000007,
        output_cost_per_token: "0.00002",
        cache_read_input_token_cost: -0.00001,
        cache_creation_input_token_cost: Number.MAX_VALUE,
      },
      {
        model_group: "untrusted-garbage",
        mode: 7,
        max_input_tokens: 3.5,
        max_output_tokens: "8192",
        input_cost_per_token: "not a number",
      },
    ] }),
  }, calls));
  const matched = matchModels(["known-model"], catalog, result.models);
  const report = renderModelReport(Object.assign(newHubState(), { models: matched.models }));

  assert.deepEqual(result.models, [
    { id: "known-model", mode: "chat", maxInputTokens: 64000, maxOutputTokens: 3, prices: { input: 7 } },
    { id: "untrusted-garbage" },
  ] satisfies GatewayModel[]);
  assert.deepEqual(matched.models[0].model.cost, { input: 7, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(matched.models[0].priceSources, {
    input: "gateway",
    output: "pi catalog",
    cacheRead: "pi catalog",
    cacheWrite: "pi catalog",
  });
  assert.equal(matched.models[0].model.contextWindow, 64000);
  assert.equal(matched.models[0].model.maxTokens, 8192);
  assert.match(report, /prices: gateway \(input\) \+ pi catalog \(output, cache read, cache write\)/);
});
