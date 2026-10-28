import assert from "node:assert/strict";
import test from "node:test";
import { thinkingFor } from "../extensions/thinking.ts";

const efforts = { low: "low", medium: "medium", high: "high" };

function model(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: "reasoning-model",
    reasoning: true,
    thinkingLevelMap: efforts,
    ...overrides,
  };
}

test("reports when a model is not in pi's catalog", () => {
  assert.deepEqual(thinkingFor(undefined, "unknown-model"), {
    reason: "not in pi's catalog",
  });
});

test("reports when a catalog model does not reason", () => {
  assert.deepEqual(thinkingFor(model({ reasoning: false }), "plain-model"), {
    reason: "model does not reason",
  });
});

test("uses catalog effort levels when they are available", () => {
  assert.deepEqual(thinkingFor(model(), "reasoning-model"), { levels: efforts });
});

test("reports when the catalog has no effort levels", () => {
  assert.deepEqual(thinkingFor(model({ thinkingLevelMap: undefined }), "plain-reasoner"), {
    reason: "catalog lists no effort levels",
  });
  assert.deepEqual(
    thinkingFor(model({ thinkingLevelMap: { low: null, high: null } }), "plain-reasoner"),
    { reason: "catalog lists no effort levels" },
  );
});

test("requires a Kimi thinking carrier before using its levels", () => {
  assert.deepEqual(thinkingFor(model({ id: "kimi-k3" }), "moonshotai/kimi-k3"), {
    reason: "kimi needs its own thinking switch",
  });
  assert.deepEqual(
    thinkingFor(model({ id: "kimi-k3", compat: { thinkingFormat: "openrouter" } }), "kimi-k3"),
    { levels: efforts },
  );
});

test("requires a DeepSeek thinking carrier and accepts its named budget field", () => {
  assert.deepEqual(thinkingFor(model({ id: "deepseek-v4" }), "gateway-alias"), {
    reason: "deepseek needs its own thinking switch",
  });
  assert.deepEqual(
    thinkingFor(
      model({ id: "deepseek-v4", compat: { thinkingTokenBudgetField: "thinking_budget" } }),
      "gateway-alias",
    ),
    { levels: efforts },
  );
});
