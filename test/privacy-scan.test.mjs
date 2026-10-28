import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scanText } from "../scripts/privacy-scan.mjs";

const scannerPath = fileURLToPath(new URL("../scripts/privacy-scan.mjs", import.meta.url));
const prePushPath = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "privacy-scan-repo-"));
  const home = join(repo, "fake-home");
  mkdirSync(home, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q"]);

  const denyValue = ["gw", "internal", "test"].join(".");
  writeFileSync(join(repo, ".git", "info", "privacy-denylist"), `${denyValue}\n`);
  return { repo, home, denyValue };
}

function runScanner(repo, home, args) {
  const result = spawnSync(process.execPath, [scannerPath, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function removeRepo(repo) {
  rmSync(repo, { recursive: true, force: true });
}

test("flags a denylisted string", () => {
  const denyValue = ["gw", "internal", "test"].join(".");
  assert.deepEqual(scanText(`host=${denyValue}`, { deny: ["", "  ", denyValue] }), [
    { line: 1, rule: "deny" },
  ]);
});

test("flags the live key without also reporting its key shape", () => {
  const liveKey = ["sk", "LIVE123456789"].join("-");
  assert.deepEqual(scanText(`x\n${liveKey}`, { deny: [], liveKey }), [
    { line: 2, rule: "live-key" },
  ]);
});

test("flags key-shaped strings but not the placeholder", () => {
  const shapedKey = ["sk", "abcdefgh12"].join("-");
  const placeholder = ["sk", "test"].join("-");
  assert.deepEqual(scanText(`${shapedKey} ${placeholder}`, { deny: [] }), [
    { line: 1, rule: "key-shape" },
  ]);
});

test("CLI reports a denylisted staged addition without echoing it", () => {
  const { repo, home, denyValue } = makeRepo();
  try {
    writeFileSync(join(repo, "staged.txt"), `host=${denyValue}\n`);
    execFileSync("git", ["-C", repo, "add", "--", "staged.txt"]);

    const result = runScanner(repo, home, ["--staged"]);
    assert.equal(result.status, 1);
    assert.match(result.output, /staged\.txt:1 deny/);
    assert.equal(result.output.includes(denyValue), false);
  } finally {
    removeRepo(repo);
  }
});

test("CLI passes clean staged content", () => {
  const { repo, home } = makeRepo();
  try {
    writeFileSync(join(repo, "clean.txt"), "ordinary content\n");
    execFileSync("git", ["-C", repo, "add", "--", "clean.txt"]);

    const result = runScanner(repo, home, ["--staged"]);
    assert.equal(result.status, 0);
    assert.equal(result.output, "");
  } finally {
    removeRepo(repo);
  }
});

test("CLI does not echo a denylisted filename", () => {
  const { repo, home, denyValue } = makeRepo();
  const shapedKey = ["sk", "abcdefgh12"].join("-");
  const filename = `${denyValue}.txt`;
  try {
    writeFileSync(join(repo, filename), `${shapedKey}\n`);
    execFileSync("git", ["-C", repo, "add", "--", filename]);

    const result = runScanner(repo, home, ["--staged"]);
    assert.equal(result.status, 1);
    assert.match(result.output, /\[redacted\]\.txt:1 key-shape/);
    assert.equal(result.output.includes(denyValue), false);
    assert.equal(result.output.includes(shapedKey), false);
  } finally {
    removeRepo(repo);
  }
});

test("CLI finds the shared denylist from a linked worktree", () => {
  const { repo, home, denyValue } = makeRepo();
  const linked = join(repo, "linked-worktree");
  try {
    execFileSync("git", ["-C", repo, "config", "user.name", "Test Runner"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "tester@example.test"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "--", "base.txt"]);
    execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "linked", linked]);

    writeFileSync(join(linked, "staged.txt"), `host=${denyValue}\n`);
    execFileSync("git", ["-C", linked, "add", "--", "staged.txt"]);
    const result = runScanner(linked, home, ["--staged"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /staged\.txt:1 deny/);
    assert.equal(result.output.includes(denyValue), false);
  } finally {
    removeRepo(repo);
  }
});

test("push scanning checks added lines, commit messages, and both email fields", () => {
  const { repo, home, denyValue } = makeRepo();
  const fakeEmail = ["reviewer@gw", "internal", "test"].join(".");
  const shapedKey = ["sk", "abcdefgh12"].join("-");
  try {
    execFileSync("git", ["-C", repo, "config", "user.name", "Test Runner"]);
    execFileSync("git", ["-C", repo, "config", "user.email", fakeEmail]);
    writeFileSync(join(repo, "source.txt"), "clean\n");
    execFileSync("git", ["-C", repo, "add", "--", "source.txt"]);
    execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"]);

    writeFileSync(join(repo, "source.txt"), `clean\n${shapedKey}\n`);
    execFileSync("git", ["-C", repo, "add", "--", "source.txt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      `deploy ${denyValue}`,
    ]);

    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const parent = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
    const result = runScanner(repo, home, ["--push", `${parent}..${head}`]);

    assert.equal(result.status, 1);
    assert.match(result.output, /source\.txt:2 key-shape/);
    assert.match(result.output, new RegExp(`commit-message/${head}:1 deny`));
    assert.match(result.output, new RegExp(`author-email/${head}:1 deny`));
    assert.match(result.output, new RegExp(`committer-email/${head}:1 deny`));
    assert.equal(result.output.includes(denyValue), false);
    assert.equal(result.output.includes(shapedKey), false);
  } finally {
    removeRepo(repo);
  }
});

test("history mode scans committed additions", () => {
  const { repo, home } = makeRepo();
  const shapedKey = ["sk", "abcdefgh12"].join("-");
  try {
    execFileSync("git", ["-C", repo, "config", "user.name", "Test Runner"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "tester@example.test"]);
    writeFileSync(join(repo, "history.txt"), `${shapedKey}\n`);
    execFileSync("git", ["-C", repo, "add", "--", "history.txt"]);
    execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "history sample"]);

    const result = runScanner(repo, home, ["--history"]);
    assert.equal(result.status, 1);
    assert.match(result.output, /history\.txt:1 key-shape/);
    assert.equal(result.output.includes(shapedKey), false);
  } finally {
    removeRepo(repo);
  }
});

test("staged scanning treats binary files as text", () => {
  const { repo, home } = makeRepo();
  const shapedKey = ["sk", "abcdefgh12"].join("-");
  try {
    writeFileSync(join(repo, "binary.dat"), Buffer.concat([Buffer.from([0]), Buffer.from(shapedKey)]));
    execFileSync("git", ["-C", repo, "add", "--", "binary.dat"]);

    const result = runScanner(repo, home, ["--staged"]);
    assert.equal(result.status, 1);
    assert.match(result.output, /binary\.dat:1 key-shape/);
    assert.equal(result.output.includes(shapedKey), false);
  } finally {
    removeRepo(repo);
  }
});

test("history scans the first-parent diff of merge resolutions", () => {
  const { repo, home, denyValue } = makeRepo();
  try {
    execFileSync("git", ["-C", repo, "config", "user.name", "Test Runner"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "tester@example.test"]);
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
    const mainBranch = execFileSync("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repo, "conflict.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "--", "conflict.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);

    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo, "conflict.txt"), "feature\n");
    execFileSync("git", ["-C", repo, "add", "--", "conflict.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "feature"]);

    execFileSync("git", ["-C", repo, "checkout", "-q", mainBranch]);
    writeFileSync(join(repo, "conflict.txt"), "main\n");
    execFileSync("git", ["-C", repo, "add", "--", "conflict.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "main"]);
    const merge = spawnSync("git", ["-C", repo, "merge", "--no-commit", "feature"], { stdio: "ignore" });
    assert.notEqual(merge.status, 0);

    writeFileSync(join(repo, "conflict.txt"), `${denyValue}\n`);
    execFileSync("git", ["-C", repo, "add", "--", "conflict.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "merge resolution"]);

    const result = runScanner(repo, home, ["--history"]);
    assert.equal(result.status, 1);
    assert.match(result.output, /conflict\.txt:1 deny/);
    assert.equal(result.output.includes(denyValue), false);
  } finally {
    removeRepo(repo);
  }
});

test("history and pre-push scan annotated tag messages", () => {
  const { repo, home } = makeRepo();
  const shapedKey = ["sk", "abcdefgh12"].join("-");
  const tagName = "release-candidate";
  try {
    execFileSync("git", ["-C", repo, "config", "user.name", "Test Runner"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "tester@example.test"]);
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "release.txt"), "release\n");
    execFileSync("git", ["-C", repo, "add", "--", "release.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "release"]);
    execFileSync("git", ["-C", repo, "tag", "-a", tagName, "-m", `release ${shapedKey}`]);

    const history = runScanner(repo, home, ["--history"]);
    assert.equal(history.status, 1);
    assert.match(history.output, new RegExp(`tag:${tagName}:1 key-shape`));
    assert.equal(history.output.includes(shapedKey), false);

    mkdirSync(join(repo, "scripts"), { recursive: true });
    copyFileSync(scannerPath, join(repo, "scripts", "privacy-scan.mjs"));
    copyFileSync(fileURLToPath(new URL("../scripts/privacy-git.mjs", import.meta.url)), join(repo, "scripts", "privacy-git.mjs"));
    const tagSha = execFileSync("git", ["-C", repo, "rev-parse", `refs/tags/${tagName}`], { encoding: "utf8" }).trim();
    const zeros = "0".repeat(tagSha.length);
    const prePush = spawnSync("sh", [prePushPath], {
      cwd: repo,
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      input: `refs/tags/${tagName} ${tagSha} refs/tags/${tagName} ${zeros}\n`,
    });
    assert.equal(prePush.status, 1);
    assert.match(prePush.stdout, new RegExp(`tag:${tagName}:1 key-shape`));
    assert.doesNotMatch(`${prePush.stdout}${prePush.stderr}`, /privacy-scan: scan failed/);
    assert.equal(`${prePush.stdout}${prePush.stderr}`.includes(shapedKey), false);
  } finally {
    removeRepo(repo);
  }
});
