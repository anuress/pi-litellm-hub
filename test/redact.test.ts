import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../extensions/redact.ts";

test("redacts the exact supplied key", () => {
  const exactKey = "custom-token-1234";
  assert.equal(redact(`token=${exactKey}`, exactKey), "token=sk-***");
});

test("ignores supplied keys shorter than eight characters", () => {
  assert.equal(redact("The gateway", "a"), "The gateway");
});

test("redacts key-shaped text inside a sentence", () => {
  const shapedKey = ["sk", "abcdefgh12"].join("-");
  assert.equal(redact(`Request failed with ${shapedKey}`), "Request failed with sk-***");
});

test("removes URL userinfo", () => {
  assert.equal(
    redact("https://u:p@litellm.example.com/x"),
    "https://litellm.example.com/x",
  );
});

test("redacts gateway host occurrences case-insensitively", () => {
  assert.equal(
    redact("Request to LITELLM.EXAMPLE.COM failed", undefined, "litellm.example.com"),
    "Request to <gateway> failed",
  );
});

test("leaves text without the gateway host unchanged", () => {
  const text = "The gateway returned a temporary error.";
  assert.equal(redact(text, undefined, "litellm.example.com"), text);
});

test("ignores gateway hosts shorter than four characters", () => {
  assert.equal(redact("gateway host api unavailable", undefined, "api"), "gateway host api unavailable");
});

test("leaves text without secrets unchanged", () => {
  const text = "The gateway returned a temporary error.";
  assert.equal(redact(text), text);
});
