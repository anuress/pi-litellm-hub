import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyFailure, registerErrors, shortMessage } from "../extensions/errors.ts";
import { bindStatus, newHubState } from "../extensions/status.ts";

type Handler = (event: any, ctx: any) => unknown;

const fakeKey = ["sk", "abcdefgh12"].join("-");
const fakeKeyHash = ["hash", "fake1234"].join("-");

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
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

function fakeContext(provider = "litellm", api = "openai-completions", id = "model-test") {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    model: { provider, api, id },
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) },
  };
  return { ctx, statuses };
}

function emitMessage(
  handlers: Map<string, Handler[]>,
  ctx: any,
  message: Record<string, unknown>,
): void {
  handlers.get("message_end")?.forEach((handler) => handler({ message }, ctx));
}

function assistant(stopReason: string, errorMessage?: string, provider = "litellm") {
  return {
    role: "assistant",
    provider,
    api: "openai-completions",
    model: "model-test",
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

test("classifies an OpenAI SDK HTTP budget error and formats the UTC reset date", () => {
  // Pi-ai's OpenAI adapter formats parsed HTTP error bodies as `400: {"message":...,"type":...}`.
  const errorMessage = `400: ${JSON.stringify({
    message: "Budget has been exceeded! Current cost: 200.01, Max budget: 200.0",
    type: "budget_exceeded",
  })}`;

  assert.equal(
    classifyFailure({
      errorMessage,
      state: { keySpend: 11, keyBudget: 50, resetAt: "2026-11-01T00:00:00+00:00" },
    }),
    "failed: out of budget ($200.01/$200.0, resets Nov 1)",
  );
});

test("classifies token-budget SDK text without adding an unknown reset date", () => {
  const errorMessage = `400: ${JSON.stringify({
    message: "ExceededTokenBudget: Current spend for token: 200.01; Max Budget for Token: 200.0",
    type: "budget_exceeded",
  })}`;

  assert.equal(
    classifyFailure({ errorMessage, state: { keySpend: 1, keyBudget: 2 } }),
    "failed: out of budget ($200.01/$200.0)",
  );
});

test("recognizes the bare Budget exceeded! message and falls back to spend state", () => {
  const errorMessage = `400: ${JSON.stringify({ message: "Budget exceeded!" })}`;

  assert.equal(
    classifyFailure({ errorMessage, state: { keySpend: 74.73, keyBudget: 200 } }),
    "failed: out of budget ($74.73/$200)",
  );
});

test("caps fallback amounts from unusually large finite state values", () => {
  const errorMessage = `400: ${JSON.stringify({ message: "Budget exceeded!" })}`;
  const reason = classifyFailure({
    errorMessage,
    state: { keySpend: Number.MAX_VALUE, keyBudget: Number.MAX_VALUE },
  });

  assert.ok((reason?.length ?? 0) <= 120);
  assert.ok(reason?.includes(`${Number.MAX_VALUE.toFixed(2).slice(0, 20)}…`));
  assert.ok(reason?.includes(`${Number.MAX_VALUE.toFixed(0).slice(0, 20)}…`));
});

test("caps unusually long budget amounts without losing the reset date", () => {
  const amount = "9".repeat(200);
  const errorMessage = `400: ${JSON.stringify({
    message: `Budget has been exceeded! Current cost: ${amount}, Max budget: ${amount}`,
    type: "budget_exceeded",
  })}`;
  const reason = classifyFailure({ errorMessage, state: { resetAt: "2026-11-01T00:00:00+00:00" } });

  assert.ok((reason?.length ?? 0) <= 120);
  assert.ok(reason?.includes(`$${"9".repeat(20)}…/$${"9".repeat(20)}…`));
  assert.ok(reason?.endsWith(", resets Nov 1)"));
});

test("classifies parallel-limit SDK text without echoing a key hash", () => {
  const errorMessage = `429: ${JSON.stringify({
    message: `max_parallel_requests reached for key hash: ${fakeKeyHash}`,
  })}`;

  assert.equal(
    classifyFailure({ errorMessage }),
    "failed: gateway busy (parallel request limit)",
  );
});

test("classifies Cloudflare 1010 HTML as a short plain-text reason", () => {
  const errorMessage =
    "403: <!DOCTYPE html><html><body><h1>Error 1010</h1><p>error code: 1010</p></body></html>";
  const reason = classifyFailure({ errorMessage });

  assert.equal(reason, "failed: blocked by Cloudflare (1010)");
  assert.ok((reason?.length ?? 0) <= 120);
  assert.equal(/[<>]/.test(reason ?? ""), false);
});

test("classifies a provider error inside an HTTP 200 stream using the adapter error text", () => {
  // OpenAI Responses emits SSE errors as `Error Code <code>: <message>`; the HTTP response is still 200.
  assert.equal(
    classifyFailure({ status: 200, errorMessage: "Error Code overloaded_error: upstream is busy" }),
    "failed: gateway error inside a 200 response: upstream is busy",
  );
  assert.ok(
    (classifyFailure({ status: 200, errorMessage: "gateway failure ".repeat(20) })?.length ?? 0) <= 120,
  );
});

test("shortMessage prefers JSON error messages, strips HTML, collapses whitespace, and caps length", () => {
  const text = `403: ${JSON.stringify({
    error: { message: "\n <strong>Readable failure</strong>   reason " },
    message: "ignored fallback",
  })}`;
  assert.equal(shortMessage(text), "Readable failure reason");
  assert.equal(
    shortMessage(`prefix {not-json} 400: {"message":"Error Code overloaded_error: nested {details}"} trailing`),
    "nested {details}",
  );
  assert.equal(shortMessage("400: Error Code overloaded_error: upstream {details}"), "upstream {details}");
  assert.equal(shortMessage('400: {"error":{"message":""},"message":"Readable fallback"}'), "Readable fallback");
  assert.equal(shortMessage(`<p>${"long ".repeat(40)}</p>`, 20).length, 20);
  assert.equal(shortMessage("x".repeat(150), Number.NaN).length, 120);
  const unicode = shortMessage("😀ab", 3);
  assert.equal(unicode, "😀…");
  assert.ok(unicode.length <= 3);
});

test("fallback status reason redacts a fake key and key hash", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();

  emitMessage(handlers, ctx, assistant("error", `400: request failed with ${fakeKey}; key hash: ${fakeKeyHash}`));

  assert.equal(state.reason?.includes(fakeKey), false);
  assert.equal(state.reason?.includes(fakeKeyHash), false);
  assert.match(state.reason ?? "", /sk-\*\*\*/);
  assert.match(state.reason ?? "", /key hash: \[redacted\]/);
});

test("a later successful LiteLLM reply clears only the failure reason owned by errors", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx, statuses } = fakeContext();

  handlers.get("before_provider_headers")?.[0]({}, ctx);
  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, ctx);
  emitMessage(handlers, ctx, assistant("error", "provider stream failed"));
  assert.equal(state.reason, "failed: gateway error inside a 200 response: provider stream failed");

  emitMessage(handlers, ctx, assistant("stop"));
  assert.equal(state.reason, undefined);
  assert.match(statuses.at(-1)?.text ?? "", /litellm ·/);
});

test("a non-LiteLLM assistant message does not consume pending LiteLLM response status", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx: litellmContext } = fakeContext();
  const { ctx: otherContext } = fakeContext("openai");

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, litellmContext);
  emitMessage(handlers, otherContext, assistant("stop", undefined, "openai"));
  emitMessage(handlers, litellmContext, assistant("error", "provider stream failed"));

  assert.equal(state.reason, "failed: gateway error inside a 200 response: provider stream failed");
});

test("an aborted assistant reply does not clear an owned reason or consume response status", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, ctx);
  emitMessage(handlers, ctx, assistant("error", "provider stream failed"));
  const ownedReason = state.reason;

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, ctx);
  emitMessage(handlers, ctx, assistant("aborted"));
  assert.equal(state.reason, ownedReason);
  emitMessage(handlers, ctx, assistant("error", "provider stream failed"));

  assert.equal(state.reason, ownedReason);
});

test("pending assistant messages preserve response status for a terminal failure", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, ctx);
  emitMessage(handlers, ctx, assistant("pending"));
  assert.equal(state.reason, undefined);
  emitMessage(handlers, ctx, assistant("error", "provider stream failed"));

  assert.equal(state.reason, "failed: gateway error inside a 200 response: provider stream failed");
});

test("a new LiteLLM request clears unmatched response status from an earlier request", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, ctx);
  handlers.get("before_provider_headers")?.[0]({}, ctx);
  emitMessage(handlers, ctx, assistant("error", "provider stream failed"));

  assert.equal(state.reason, "failed: provider stream failed");
});

test("an explicit SDK error status takes precedence over a cached 200 response status", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, ctx);
  emitMessage(handlers, ctx, assistant("error", "litellm API (400): unclassified provider failure"));

  assert.equal(state.reason, "failed: unclassified provider failure");
});

test("interleaved requests for different LiteLLM models keep their response statuses separate", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx: firstModel } = fakeContext("litellm", "openai-completions", "model-one");
  const { ctx: secondModel } = fakeContext("litellm", "openai-completions", "model-two");

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, firstModel);
  handlers.get("before_provider_headers")?.[0]({}, secondModel);
  emitMessage(handlers, secondModel, assistant("stop"));
  emitMessage(handlers, firstModel, assistant("error", "provider stream failed"));

  assert.equal(state.reason, "failed: gateway error inside a 200 response: provider stream failed");
});

test("a successful reply does not clear a reason another observer replaced", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();

  emitMessage(handlers, ctx, assistant("error", "provider stream failed"));
  state.reason = "cache warning from another observer";
  emitMessage(handlers, ctx, assistant("stop"));

  assert.equal(state.reason, "cache warning from another observer");
});

test("non-LiteLLM provider errors do not change status state or publish failures", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  const failures: unknown[] = [];
  state.reason = "keep this reason";
  bindStatus(state, { emit: (channel, data) => {
    if (channel === "litellm-hub:failure") failures.push(data);
  } });
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx, statuses } = fakeContext("openai");

  emitMessage(handlers, ctx, assistant("error", "upstream failure", "openai"));

  assert.equal(state.reason, "keep this reason");
  assert.equal(statuses.length, 0);
  assert.equal(failures.length, 0);
});

test("classified LiteLLM failures publish model and redacted reason", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const host = "litellm.example.com";
  bindStatus(state, {
    key: fakeKey,
    host,
    emit: (channel, data) => emitted.push({ channel, data }),
  });
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();

  handlers.get("after_provider_response")?.[0]({ status: 200, headers: {} }, ctx);
  emitMessage(handlers, ctx, assistant("error", `request failed at ${host} with ${fakeKey}`));

  const failures = emitted.filter(({ channel }) => channel === "litellm-hub:failure");
  assert.equal(failures.length, 1);
  const failure = failures[0].data as { model: string; reason: string; at: string };
  assert.equal(failure.model, "model-test");
  assert.equal(failure.reason, "failed: gateway error inside a 200 response: request failed at <gateway> with sk-***");
  assert.equal(failure.reason.includes(fakeKey), false);
  assert.equal(failure.reason.includes(host), false);
  assert.ok(!Number.isNaN(Date.parse(failure.at)));
  assert.deepEqual(emitted.map(({ channel }) => channel), ["litellm-hub:failure", "litellm-hub:state"]);
});

test("an HTTP budget error uses its status prefix when after_provider_response does not fire", () => {
  const { pi, handlers } = fakeRuntime();
  const state = newHubState();
  registerErrors(pi, state, { apiKey: fakeKey });
  const { ctx } = fakeContext();
  const errorMessage = `litellm API error (400): ${JSON.stringify({
    message: "Current cost: 3.25, Max budget: 3",
    type: "budget_exceeded",
  })}`;

  emitMessage(handlers, ctx, assistant("error", errorMessage));

  assert.equal(state.reason, "failed: out of budget ($3.25/$3)");
});
