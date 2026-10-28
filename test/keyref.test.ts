import assert from "node:assert/strict";
import test from "node:test";
import { resolveKeyRef } from "../extensions/keyref.ts";

const fakeValue = ["fake", "gateway", "key"].join("-");

test("resolves dollar and braced environment references", () => {
  const env = { X: fakeValue };
  assert.equal(resolveKeyRef("$X", env), fakeValue);
  assert.equal(resolveKeyRef("${X}", env), fakeValue);
  assert.equal(resolveKeyRef("$MISSING", env), undefined);
});

test("runs a bang command through the injected runner and trims stdout", () => {
  let command = "";
  const result = resolveKeyRef("!printf fake", {}, (value) => {
    command = value;
    return `  ${fakeValue}\n`;
  });

  assert.equal(command, "printf fake");
  assert.equal(result, fakeValue);
});

test("returns undefined when a command runner fails", () => {
  assert.equal(
    resolveKeyRef("!not-a-real-command", {}, () => {
      throw new Error("runner failed");
    }),
    undefined,
  );
});

test("returns literal references unchanged", () => {
  assert.equal(resolveKeyRef("literal-value", {}), "literal-value");
});
