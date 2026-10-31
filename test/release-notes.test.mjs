import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/release-notes.mjs", import.meta.url));

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "release-notes-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test Runner"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "tester@example.test"]);
  execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  return repo;
}

function commit(repo, subject, filename = "change.txt") {
  writeFileSync(join(repo, filename), `${subject}\n`);
  execFileSync("git", ["-C", repo, "add", "--", filename]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", subject]);
  return execFileSync("git", ["-C", repo, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
}

function runScript(repo, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: repo, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function removeRepo(repo) {
  rmSync(repo, { recursive: true, force: true });
}

test("notes list non-release commits since the previous tag", () => {
  const repo = makeRepo();
  try {
    commit(repo, "feat: first release change");
    execFileSync("git", ["-C", repo, "tag", "v0.1.0"]);
    const fixHash = commit(repo, "fix: second release change");
    const featureHash = commit(repo, "feat: third release change");
    commit(repo, "chore: release 0.1.1");
    execFileSync("git", ["-C", repo, "tag", "v0.1.1"]);

    const result = runScript(repo, ["v0.1.1"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [
      `- feat: third release change (${featureHash})`,
      `- fix: second release change (${fixHash})`,
    ]);
  } finally {
    removeRepo(repo);
  }
});

test("the first tag uses whole history and an untagged target supports --to", () => {
  const repo = makeRepo();
  try {
    commit(repo, "chore: release 0.1.0");
    const target = commit(repo, "feat: initial change");
    execFileSync("git", ["-C", repo, "tag", "v0.1.0"]);

    const firstTag = runScript(repo, ["v0.1.0"]);
    assert.equal(firstTag.status, 0, firstTag.stderr);
    assert.equal(firstTag.stdout.trim(), `- feat: initial change (${target})`);

    commit(repo, "chore: release 0.1.1");
    const noChanges = runScript(repo, ["v0.1.1", "--to", "HEAD"]);
    assert.equal(noChanges.status, 0, noChanges.stderr);
    assert.equal(noChanges.stdout.trim(), "- No changes listed.");
  } finally {
    removeRepo(repo);
  }
});
