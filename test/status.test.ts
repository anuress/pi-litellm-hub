import assert from "node:assert/strict";
import test from "node:test";
import {
  bindStatus,
  hubSnapshot,
  newHubState,
  renderModelReport,
  renderStatus,
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

test("a reason replaces the active model details", () => {
  assert.equal(
    renderStatus(activeState({ reason: "gateway unavailable", ...spend })),
    "litellm · model-one · gateway unavailable",
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
      { id: "plain-model", api: "openai-responses", catalogSource: "openai", model: {} },
      {
        id: "reasoning-model",
        api: "anthropic-messages",
        catalogSource: "anthropic",
        levels: { off: null, low: "low", high: "high" },
        model: {},
      },
    ],
    skipped: [{ id: "text-embedding-model", reason: "not a chat model" }],
    lastCache: "cache: hit (read 10.3k)",
  });
  const report = renderModelReport(state);

  assert.match(report, /2 matched, 1 skipped/);
  assert.match(report, /plain-model \| openai-responses \| pi default \| openai/);
  assert.match(report, /reasoning-model \| anthropic-messages \| low, high \| anthropic/);
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
  const state = activeState({ reason: `failed at https://${host} with ${fakeKey}` });
  state.models.push({
    id: "model-one",
    api: "openai-responses",
    levels: { low: "low", off: null },
    model: {},
  });

  const snapshot = hubSnapshot(state, { key: fakeKey, host });

  assert.deepEqual(Object.keys(snapshot).sort(), [
    "at",
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
  assert.deepEqual(snapshot.levelsAvailable, ["low"]);
  assert.equal(snapshot.configured, true);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(fakeKey), false);
  assert.equal(serialized.includes(host), false);
  assert.match(serialized, /<gateway>/);
});

test("snapshot leaves levels undefined when the active model has no map", () => {
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
