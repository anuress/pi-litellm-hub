import assert from "node:assert/strict";
import test from "node:test";
import { gatewayGetJson } from "../extensions/gateway.ts";

const cfg = { baseUrl: "https://litellm.example.com", apiKeyRef: "$LITELLM_API_KEY", claudeCache: false };
const fakeApiKey = ["sk", "abcdefgh12"].join("-");

test("times out gateway requests with a readable duration", async () => {
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing abort signal"));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  await assert.rejects(
    gatewayGetJson(cfg, fakeApiKey, "/v1/models", fetchImpl, 50),
    /gateway \/v1\/models timed out after 0\.05s/,
  );
});

test("bounds non-2xx response reads and cancels the stream early", async () => {
  let chunksYielded = 0;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksYielded === 1024) {
        controller.close();
        return;
      }
      chunksYielded += 1;
      controller.enqueue(new Uint8Array(1024).fill(0x61));
    },
    cancel() {
      cancelled += 1;
    },
  });
  const fetchImpl: typeof fetch = async () => new Response(body, { status: 403 });

  await assert.rejects(
    gatewayGetJson(cfg, fakeApiKey, "/v1/models", fetchImpl),
    (error: Error) => {
      assert.match(error.message, /gateway \/v1\/models returned 403/);
      assert.ok(error.message.length <= 300);
      assert.ok(chunksYielded < 1024);
      assert.equal(cancelled, 1);
      return true;
    },
  );
});
