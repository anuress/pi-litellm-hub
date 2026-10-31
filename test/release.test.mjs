import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "release-script-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test Runner"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "tester@example.test"]);
  execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "package.json"), '{\n  "name": "release-test",\n  "version": "0.1.1"\n}\n');
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "--", "package.json", "base.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "chore: release 0.1.1"]);
  execFileSync("git", ["-C", repo, "tag", "v0.1.1"]);
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  execFileSync("git", ["-C", repo, "add", "--", "feature.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "feat: add release feature"]);
  writeFileSync(join(repo, "fix.txt"), "fix\n");
  execFileSync("git", ["-C", repo, "add", "--", "fix.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fix: repair release issue"]);
  return repo;
}

function runRelease(repo, version) {
  const result = spawnSync(process.execPath, [scriptPath, version], { cwd: repo, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function removeRepo(repo) {
  rmSync(repo, { recursive: true, force: true });
}

test("release bumps the package, commits, and creates an annotated changelog tag", () => {
  const repo = makeRepo();
  try {
    const result = runRelease(repo, "0.2.0");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "git push origin main v0.2.0\n");
    const packageText = readFileSync(join(repo, "package.json"), "utf8");
    const packageJson = JSON.parse(packageText);
    assert.equal(packageJson.version, "0.2.0");
    assert.equal(packageText, `${JSON.stringify(packageJson, null, 2)}\n`);
    assert.equal(
      execFileSync("git", ["-C", repo, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
      "chore: release 0.2.0",
    );
    assert.equal(
      execFileSync("git", ["-C", repo, "cat-file", "-t", "refs/tags/v0.2.0"], { encoding: "utf8" }).trim(),
      "tag",
    );
    const tagObject = execFileSync("git", ["-C", repo, "cat-file", "-p", "refs/tags/v0.2.0"], { encoding: "utf8" });
    const message = tagObject.slice(tagObject.indexOf("\n\n") + 2).trimEnd();
    assert.deepEqual(message.split("\n\n"), [
      "v0.2.0",
      "- fix: repair release issue (" + execFileSync("git", ["-C", repo, "rev-parse", "--short=7", "HEAD^"], { encoding: "utf8" }).trim() + ")\n- feat: add release feature (" + execFileSync("git", ["-C", repo, "rev-parse", "--short=7", "HEAD^^"], { encoding: "utf8" }).trim() + ")",
    ]);
    assert.equal(message.includes("chore: release 0.2.0"), false);
  } finally {
    removeRepo(repo);
  }
});

test("release refuses a dirty working tree without changing the package or history", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, "untracked.txt"), "dirty\n");
    const before = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = runRelease(repo, "0.2.0");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /working tree must be clean/);
    assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, "0.1.1");
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before);
    const tagCheck = spawnSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/tags/v0.2.0"]);
    assert.equal(tagCheck.status, 1);
  } finally {
    removeRepo(repo);
  }
});

test("release refuses to run outside main", () => {
  const repo = makeRepo();
  try {
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature"]);
    const result = runRelease(repo, "0.2.0");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release must run on the main branch/);
    assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, "0.1.1");
  } finally {
    removeRepo(repo);
  }
});
