import assert from "node:assert/strict";
import test from "node:test";
import {
  bindStatus,
  hubSnapshot,
  newHubState,
  renderModelReport,
  renderStatus,
  supportedLevels,
  updateStatus,
} from "../extensions/status.ts";

const spend = {
  keySpend: 74.73,
  keyBudget: 200,
  resetAt: "2026-11-01T00:00:00+00:00",
};

function activeState(overrides: Record<string, unknown> = {}) {
  return Object.assign(newHubState(), {
    activeModelId: "model-one",
    thinking: "high",
    sessionCost: 0.12,
    ...overrides,
  });
}

test("renders the complete normal status line with month spend and UTC reset date", () => {
  assert.equal(
    renderStatus(activeState(spend)),
    "litellm · model-one · thinking high · session $0.12 · month $74.73/$200 (resets Nov 1)",
  );
});

test("shows fallback and retry markers only for positive attempt counts", () => {
  assert.equal(
    renderStatus(activeState({ attemptedFallbacks: 1 })),
    "litellm · model-one · thinking high · session $0.12 · fallback",
  );
  assert.equal(
    renderStatus(activeState({ attemptedRetries: 2 })),
    "litellm · model-one · thinking high · session $0.12 · retry×2",
  );
  assert.equal(
    renderStatus(activeState({ attemptedFallbacks: 1, attemptedRetries: 2 })),
    "litellm · model-one · thinking high · session $0.12 · fallback · retry×2",
  );
  assert.equal(
    renderStatus(activeState({ attemptedFallbacks: 0, attemptedRetries: 0 })),
    "litellm · model-one · thinking high · session $0.12",
  );
});

test("renders estimated session cost with the exact estimate marker", () => {
  assert.equal(
    renderStatus(activeState({ sessionEstimated: true })),
    "litellm · model-one · thinking high · session ~$0.12 (est.)",
  );
});

test("uses default and off thinking labels when selected", () => {
  assert.match(renderStatus(activeState({ thinking: undefined })), /thinking default/);
  assert.match(renderStatus(activeState({ thinking: "off" })), /thinking off/);
});

test("uses a non-month window label", () => {
  assert.equal(
    renderStatus(activeState({ ...spend, window: "7d" })),
    "litellm · model-one · thinking high · session $0.12 · 7d $74.73/$200 (resets Nov 1)",
  );
});

test("a reason replaces the active model details but retains route signals", () => {
  assert.equal(
    renderStatus(activeState({ reason: "gateway unavailable", ...spend })),
    "litellm · model-one · gateway unavailable",
  );
  assert.equal(
    renderStatus(activeState({ reason: "gateway unavailable", attemptedRetries: 2 })),
    "litellm · model-one · gateway unavailable · retry×2",
  );
});

test("renders not-configured status", () => {
  assert.equal(
    renderStatus(Object.assign(newHubState(), { notConfigured: "no gateway URL" })),
    "litellm · not configured: no gateway URL",
  );
});

test("renders model count and spend when there is no active LiteLLM model", () => {
  const state = Object.assign(newHubState(), {
    models: [{}, {}, {}],
    ...spend,
  });
  assert.equal(renderStatus(state), "litellm · 3 models · month $74.73/$200 (resets Nov 1)");
});

test("model report lists default thinking and skipped model reasons", () => {
  const state = Object.assign(newHubState(), {
    models: [
      { id: "plain-model", api: "openai-responses", catalogSource: "openai", model: { reasoning: true } },
      {
        id: "reasoning-model",
        api: "anthropic-messages",
        catalogSource: "anthropic",
        levels: { off: null, low: "low", high: "high" },
        model: { reasoning: true },
      },
    ],
    skipped: [{ id: "text-embedding-model", reason: "not a chat model" }],
    lastCache: "cache: hit (read 10.3k)",
  });
  const report = renderModelReport(state);

  assert.match(report, /2 matched, 1 skipped/);
  assert.match(report, /plain-model \| openai-responses \| off, minimal, low, medium, high \(pi default\) \| openai/);
  assert.match(report, /reasoning-model \| anthropic-messages \| minimal, low, medium, high \| anthropic/);
  assert.match(report, /Last Claude cache: cache: hit \(read 10\.3k\)/);
  assert.match(report, /Skipped:\n- text-embedding-model — not a chat model/);
});

test("updateStatus redacts a key embedded in the status reason", () => {
  const fakeKey = ["sk", "abcdefgh12"].join("-");
  const state = activeState({ reason: `request failed: ${fakeKey}` });
  let status = "";

  updateStatus({ ui: { setStatus: (_key, text) => (status = text ?? "") } }, state, fakeKey);

  assert.equal(status.includes(fakeKey), false);
  assert.equal(status, "litellm · model-one · request failed: sk-***");
});

test("snapshot uses an exact allowlist and redacts its reason", () => {
  const fakeKey = ["sk", "abcdefgh12"].join("-");
  const host = "litellm.example.com";
  const state = activeState({
    reason: `failed at https://${host} with ${fakeKey}`,
    attemptedFallbacks: 1,
    attemptedRetries: 2,
  });
  state.models.push({
    id: "model-one",
    api: "openai-responses",
    levels: { max: "max" },
    model: { reasoning: true },
  });

  const snapshot = hubSnapshot(state, { key: fakeKey, host });

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
  assert.deepEqual(snapshot.levelsAvailable, supportedLevels(state.models[0]));
  assert.deepEqual(snapshot.levelsAvailable, ["off", "minimal", "low", "medium", "high", "max"]);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.attemptedFallbacks, 1);
  assert.equal(snapshot.attemptedRetries, 2);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(fakeKey), false);
  assert.equal(serialized.includes(host), false);
  assert.match(serialized, /<gateway>/);
});

function levelModel(levels: Record<string, string | null> | undefined, reasoning = true) {
  return { id: "m", api: "openai-responses", levels, model: { reasoning } } as any;
}

test("supportedLevels mirrors pi's resolution", () => {
  const all = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  assert.deepEqual(supportedLevels(levelModel({ max: "max" })), ["off", "minimal", "low", "medium", "high", "max"]);
  assert.deepEqual(supportedLevels(levelModel(Object.fromEntries(all.map((l) => [l, l])))), all);
  assert.deepEqual(
    supportedLevels(levelModel({ medium: null, xhigh: null, max: "max" })),
    ["off", "minimal", "low", "high", "max"],
  );
  assert.deepEqual(supportedLevels(levelModel(undefined)), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(supportedLevels(levelModel({ high: "high" }, false)), ["off"]);
});

test("snapshot leaves levels undefined when there is no active matched model", () => {
  const state = activeState();

  assert.equal(hubSnapshot(state, {}).levelsAvailable, undefined);
});

test("updateStatus emits once and uses bound key and host when no key is passed", () => {
  const fakeKey = ["sk", "abcdefgh12"].join("-");
  const host = "litellm.example.com";
  const state = activeState({ reason: `failed at ${host} with ${fakeKey}` });
  const emitted: Array<{ channel: string; data: unknown }> = [];
  let status = "";
  bindStatus(state, {
    key: fakeKey,
    host,
    emit: (channel, data) => emitted.push({ channel, data }),
  });

  updateStatus({ ui: { setStatus: (_key, text) => (status = text ?? "") } }, state);

  assert.equal(status.includes(fakeKey), false);
  assert.equal(status.includes(host), false);
  assert.match(status, /<gateway>/);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].channel, "litellm-hub:state");
  assert.equal((emitted[0].data as { reason?: string }).reason, `failed at <gateway> with sk-***`);
});
