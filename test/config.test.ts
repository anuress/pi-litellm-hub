import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../extensions/config.ts";

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "litellm-config-home-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  return home;
}

function writeSettings(home: string, value: unknown): void {
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify(value));
}

function writeAuth(home: string, value: unknown): void {
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify(value));
}

function withHome(run: (home: string) => void): void {
  const home = makeHome();
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function configFor(home: string, env: Record<string, string | undefined> = {}) {
  return loadConfig(
    {
      LITELLM_BASE_URL: "https://litellm.example.com",
      LITELLM_API_KEY: "sk-test",
      ...env,
    },
    home,
  );
}

const remoteHttpUrl = "https://litellm.example.com".replace("https:", "http:");
const fakeStoredKey = ["sk", "abcdefgh12"].join("-");

function createStoredApiKeyCommand(home: string): string {
  writeAuth(home, { litellm: { key: fakeStoredKey } });
  const result = loadConfig({ LITELLM_BASE_URL: "https://litellm.example.com" }, home);
  if (!result.ok) throw new Error("Expected config to use the stored test credential");

  const command = result.config.apiKeyRef;
  assert.ok(command.startsWith("!"));
  assert.equal(command.includes(fakeStoredKey), false);
  return command.slice(1);
}

function runStoredApiKeyCommand(command: string, home: string) {
  return spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
}

test("environment URL takes precedence over settings", () => {
  withHome((home) => {
    writeSettings(home, { litellmHub: { baseUrl: "https://litellm.example.com/settings" } });
    const result = configFor(home, { LITELLM_BASE_URL: "https://litellm.example.com/env" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.config.baseUrl, "https://litellm.example.com/env");
  });
});

test("normalizes a trimmed, versioned gateway URL", () => {
  withHome((home) => {
    const result = configFor(home, {
      LITELLM_BASE_URL: "  https://litellm.example.com/v1/  ",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.config.baseUrl, "https://litellm.example.com");
  });
});

test("reports a missing gateway URL", () => {
  withHome((home) => {
    const result = loadConfig({ LITELLM_API_KEY: "sk-test" }, home);
    assert.deepEqual(result, { ok: false, reason: "no gateway URL" });
  });
});

test("reports an invalid gateway URL", () => {
  withHome((home) => {
    const result = configFor(home, { LITELLM_BASE_URL: "not a URL" });
    assert.deepEqual(result, { ok: false, reason: "gateway URL is not a valid URL" });
  });
});

test("rejects a URL with a username", () => {
  withHome((home) => {
    const result = configFor(home, { LITELLM_BASE_URL: "https://u@litellm.example.com" });
    assert.deepEqual(result, {
      ok: false,
      reason: "gateway URL must not contain credentials",
    });
  });
});

test("rejects a URL with a username and password", () => {
  withHome((home) => {
    const result = configFor(home, {
      LITELLM_BASE_URL: "https://u:p@litellm.example.com/v1",
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "gateway URL must not contain credentials",
    });
  });
});

test("rejects non-local HTTP gateway URLs", () => {
  withHome((home) => {
    const result = configFor(home, { LITELLM_BASE_URL: remoteHttpUrl });
    assert.deepEqual(result, { ok: false, reason: "gateway URL must be https" });
  });
});

test("allows localhost HTTP gateway URLs", () => {
  withHome((home) => {
    const result = configFor(home, { LITELLM_BASE_URL: "http://localhost:4000" });
    assert.equal(result.ok, true);
  });
});

test("uses an environment variable reference when the key is configured", () => {
  withHome((home) => {
    const result = configFor(home);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.apiKeyRef, "$LITELLM_API_KEY");
      assert.deepEqual(Object.keys(result.config).sort(), ["apiKeyRef", "baseUrl"]);
    }
  });
});

test("uses a command reference for a stored key without embedding the key", () => {
  withHome((home) => {
    const command = createStoredApiKeyCommand(home);
    const execution = runStoredApiKeyCommand(command, home);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, fakeStoredKey);
    assert.equal(execution.stderr, "");
  });
});

test("fails quietly when the auth file becomes malformed", () => {
  withHome((home) => {
    const command = createStoredApiKeyCommand(home);
    writeFileSync(join(home, ".pi", "agent", "auth.json"), "{");

    const execution = runStoredApiKeyCommand(command, home);
    assert.equal(execution.status, 1);
    assert.equal(execution.stdout, "");
    assert.equal(execution.stderr, "");
  });
});

test("fails quietly when the auth file no longer has a key", () => {
  withHome((home) => {
    const command = createStoredApiKeyCommand(home);
    writeAuth(home, { litellm: {} });

    const execution = runStoredApiKeyCommand(command, home);
    assert.equal(execution.status, 1);
    assert.equal(execution.stdout, "");
    assert.equal(execution.stderr, "");
  });
});

test("reports a missing API key", () => {
  withHome((home) => {
    const result = loadConfig({ LITELLM_BASE_URL: "https://litellm.example.com" }, home);
    assert.deepEqual(result, { ok: false, reason: "no key" });
  });
});

test("treats malformed auth JSON as absent", () => {
  withHome((home) => {
    writeFileSync(join(home, ".pi", "agent", "auth.json"), "{");
    const result = loadConfig({ LITELLM_BASE_URL: "https://litellm.example.com" }, home);
    assert.deepEqual(result, { ok: false, reason: "no key" });
  });
});

test("ignores a project-local pi settings file", () => {
  const previousCwd = process.cwd();
  const cwd = mkdtempSync(join(tmpdir(), "litellm-project-config-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ litellmHub: { baseUrl: "https://litellm.example.com/project" } }),
    );
    withHome((home) => {
      writeSettings(home, { litellmHub: { baseUrl: "https://litellm.example.com" } });
      process.chdir(cwd);
      const result = loadConfig({ LITELLM_API_KEY: "sk-test" }, home);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.config.baseUrl, "https://litellm.example.com");
    });
  } finally {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("treats malformed settings JSON as absent", () => {
  withHome((home) => {
    writeFileSync(join(home, ".pi", "agent", "settings.json"), "{");
    const result = loadConfig({ LITELLM_API_KEY: "sk-test" }, home);
    assert.deepEqual(result, { ok: false, reason: "no gateway URL" });
  });
});
