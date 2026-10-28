import assert from "node:assert/strict";
import test from "node:test";
import { matchModels, type Catalog } from "../extensions/models.ts";

type Entry = {
  provider: string;
  id: string;
  levels?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  type?: string;
};

function fakeCatalog(entries: Entry[]): Catalog {
  const providers = [...new Set(entries.map((entry) => entry.provider))];
  return {
    providers: () => providers,
    models: (provider) =>
      entries
        .filter((entry) => entry.provider === provider)
        .map(({ provider: _provider, id, levels, compat, type }) => ({
          id,
          name: id,
          api: "openai-completions",
          ...(type !== undefined ? { type } : {}),
          provider,
          baseUrl: "https://litellm.example.com/v1",
          reasoning: true,
          ...(levels !== undefined ? { thinkingLevelMap: levels } : {}),
          ...(compat !== undefined ? { compat } : {}),
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        })),
  };
}

function map(value: string): Record<string, string | null> {
  return { high: value };
}

test("trims ids, drops empty values, and keeps the first duplicate", () => {
  const result = matchModels(
    ["gpt-6-luna", "gpt-6-luna", "", " ", " gpt-6-luna "],
    fakeCatalog([{ provider: "openai", id: "gpt-6-luna", levels: map("max") }]),
  );

  assert.deepEqual(result.models.map((model) => model.id), ["gpt-6-luna"]);
});

test("prefers openai over Azure and OpenCode when effort maps differ", () => {
  const result = matchModels(
    ["gpt-6-luna"],
    fakeCatalog([
      { provider: "openai", id: "gpt-6-luna", levels: { off: null, high: "high", max: "max" } },
      { provider: "azure-openai-responses", id: "gpt-6-luna", levels: map("azure") },
      { provider: "opencode", id: "gpt-6-luna", levels: map("opencode") },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "openai");
  assert.equal(result.models[0].levels?.max, "max");
  assert.equal(result.models[0].reason, undefined);
});

test("checks chat type only on the priority-chosen entry", () => {
  const result = matchModels(
    ["x"],
    fakeCatalog([
      { provider: "openai", id: "x", levels: map("chat"), type: "chat" },
      { provider: "opencode", id: "x", levels: map("image"), type: "image" },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "openai");
  assert.deepEqual(result.skipped, []);
});

test("prefers the vendor catalog over OpenRouter and Nvidia", () => {
  const result = matchModels(
    ["moonshotai/kimi-k3"],
    fakeCatalog([
      { provider: "openrouter", id: "kimi-k3", levels: map("router") },
      { provider: "nvidia", id: "kimi-k3", levels: map("nvidia") },
      {
        provider: "moonshotai",
        id: "kimi-k3",
        levels: map("moonshot"),
        compat: { thinkingFormat: "openrouter" },
      },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "moonshotai");
  assert.equal(result.models[0].levels?.high, "moonshot");
  assert.equal(result.models[0].reason, undefined);
});

test("maps vendor prefixes to their catalog provider names", () => {
  const mappings = [
    ["z-ai/glm-5.3", "zai", "glm-5.3"],
    ["x-ai/grok-model", "xai", "grok-model"],
    ["deepseek/deepseek-v4-pro", "deepseek", "deepseek-v4-pro"],
    ["google/gemini-model", "google", "gemini-model"],
    ["gemini/gemini-model", "google", "gemini-model"],
  ] as const;
  const entries: Entry[] = [];
  for (const [id, provider, modelId] of mappings) {
    entries.push(
      { provider: "openai", id: modelId, levels: map("openai") },
      { provider, id: modelId, levels: map("vendor") },
    );
  }

  const result = matchModels(mappings.map(([id]) => id), fakeCatalog(entries));
  assert.deepEqual(result.models.map((model) => model.catalogSource), mappings.map(([, provider]) => provider));
});

test("uses alphabetical order after first-party and aggregator providers", () => {
  const result = matchModels(
    ["fallback-model", "aggregator-model"],
    fakeCatalog([
      { provider: "nvidia", id: "fallback-model", levels: map("nvidia") },
      { provider: "github-copilot", id: "fallback-model", levels: map("copilot") },
      { provider: "azure-openai-responses", id: "fallback-model", levels: map("azure") },
      { provider: "opencode", id: "aggregator-model", levels: map("opencode") },
      { provider: "openrouter", id: "aggregator-model", levels: map("openrouter") },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "azure-openai-responses");
  assert.equal(result.models[0].levels?.high, "azure");
  assert.equal(result.models[0].reason, undefined);
  assert.equal(result.models[1].catalogSource, "openrouter");
});

test("leaves a missing map to pi defaults and omits it from the model config", () => {
  const result = matchModels(
    ["default-reasoning-model"],
    fakeCatalog([{ provider: "openai", id: "default-reasoning-model" }]),
  );

  assert.equal(result.models[0].reason, undefined);
  assert.equal(result.models[0].levels, undefined);
  assert.equal("thinkingLevelMap" in result.models[0].model, false);
});

test("treats an unknown vendor prefix as a literal string", () => {
  const result = matchModels(["constructor/model-id"], fakeCatalog([]));

  assert.equal(result.models[0].reason, "not in pi's catalog");
});

test("reports ambiguity for different maps at the same provider rank", () => {
  const result = matchModels(
    ["same-priority-model"],
    fakeCatalog([
      { provider: "openai", id: "same-priority-model", levels: map("one") },
      { provider: "openai", id: "same-priority-model", levels: map("two") },
    ]),
  );

  assert.equal(result.models[0].catalogSource, "openai");
  assert.equal(result.models[0].reason, "ambiguous catalog match");
  assert.equal(result.models[0].levels, undefined);
  assert.equal("thinkingLevelMap" in result.models[0].model, false);
});
