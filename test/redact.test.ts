import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../extensions/redact.ts";

test("redacts the exact supplied key", () => {
  assert.equal(redact("token=sk-test", "sk-test"), "token=sk-***");
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

test("leaves text without secrets unchanged", () => {
  const text = "The gateway returned a temporary error.";
  assert.equal(redact(text), text);
});
