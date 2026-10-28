import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAddedLines, scanAllTagMessages, scanTagMessage } from "./privacy-git.mjs";

const KEY_SHAPE = /sk-[A-Za-z0-9_-]{8,}/g;
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

export function scanText(text, { deny = [], liveKey } = {}) {
  const denyEntries = Array.isArray(deny)
    ? deny
        .filter((entry) => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim())
    : [];
  const lines = String(text).split(/\r?\n/);
  const hits = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hasDeny = denyEntries.some((entry) => line.includes(entry));
    const hasLiveKey = typeof liveKey === "string" && liveKey.length > 0 && line.includes(liveKey);
    const hasKeyShape = [...line.matchAll(KEY_SHAPE)].some(
      ([token]) => token !== "sk-test" && token !== liveKey,
    );

    if (hasDeny) hits.push({ line: index + 1, rule: "deny" });
    if (hasLiveKey) hits.push({ line: index + 1, rule: "live-key" });
    else if (hasKeyShape) hits.push({ line: index + 1, rule: "key-shape" });
  }

  return hits;
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("git command failed");
  }
}

function loadDenylist() {
  const commonDirOutput = runGit(["rev-parse", "--git-common-dir"]);
  const commonDir = resolve(process.cwd(), commonDirOutput.replace(/\r?\n$/, ""));
  const denylistPath = resolve(commonDir, "info", "privacy-denylist");

  try {
    return readFileSync(denylistPath, "utf8")
      .split(/\r?\n/)
      .filter((entry) => entry.trim() !== "")
      .map((entry) => entry.trim());
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("privacy denylist unavailable");
  }
}

function loadLiveKey() {
  const environmentKey = process.env.LITELLM_API_KEY;
  if (typeof environmentKey === "string" && environmentKey.length > 0) return environmentKey;

  const home = process.env.HOME || homedir();
  const authPath = resolve(home, ".pi", "agent", "auth.json");
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const credential = auth?.litellm;
    for (const value of [credential?.key, credential?.apiKey, credential?.access]) {
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // Missing or invalid local auth data is not a scan failure.
  }

  return undefined;
}

function addEmailHits(line, kind, commitId, rules, hits) {
  const email = line.match(/<([^<>]+)>\s*$/)?.[1];
  if (!email) return;

  for (const hit of scanText(email, rules)) {
    hits.push({ path: `${kind}-email/${commitId}`, line: hit.line, rule: hit.rule });
  }
}

function scanLogOutput(log, rules) {
  const hits = [];
  let commitId = "unknown";
  let section = "outside";
  let messageLines = [];
  let patchLines = [];

  const flushMessage = () => {
    if (messageLines.length > 0) {
      for (const hit of scanText(messageLines.join("\n"), rules)) {
        hits.push({ path: `commit-message/${commitId}`, line: hit.line, rule: hit.rule });
      }
    }
    messageLines = [];
  };
  const flushPatch = () => {
    if (patchLines.length > 0) hits.push(...scanAddedLines(patchLines.join("\n"), rules, scanText));
    patchLines = [];
  };

  for (const line of log.split(/\r?\n/)) {
    const commit = line.match(/^commit ([0-9a-f]+)/);
    if (commit) {
      flushMessage();
      flushPatch();
      commitId = commit[1];
      section = "metadata";
      continue;
    }

    if (line.startsWith("diff --git ")) {
      if (section === "message") flushMessage();
      section = "patch";
      patchLines.push(line);
      continue;
    }

    if (section === "patch") {
      patchLines.push(line);
    } else if (section === "metadata") {
      if (line.startsWith("Author:")) addEmailHits(line, "author", commitId, rules, hits);
      else if (line.startsWith("Commit:")) addEmailHits(line, "committer", commitId, rules, hits);
      else if (line === "") section = "message";
    } else if (section === "message") {
      messageLines.push(line.startsWith("    ") ? line.slice(4) : line);
    }
  }

  flushMessage();
  flushPatch();
  return hits;
}

function formatPath(path, rules) {
  const secrets = [...rules.deny, rules.liveKey].filter((value) => typeof value === "string" && value.length > 0);
  let safePath = path;
  for (const secret of secrets) safePath = safePath.split(secret).join("[redacted]");
  safePath = safePath.replace(KEY_SHAPE, (token) => (token === "sk-test" ? token : "[redacted]"));
  const escapes = { "\\": "\\\\", "\t": "\\t", "\r": "\\r", "\n": "\\n" };
  return safePath.replace(/[\\\t\r\n]/g, (character) => escapes[character]);
}

function printUsage() {
  process.stderr.write("Usage: node scripts/privacy-scan.mjs --staged | --push <range> | --tag <name> <sha> | --history\n");
}

function main(args) {
  let mode;
  if (args.length === 1 && args[0] === "--staged") {
    mode = { type: "staged" };
  } else if (
    args.length === 2 &&
    args[0] === "--push" &&
    args[1].length > 0 &&
    !args[1].startsWith("-")
  ) {
    mode = { type: "push", range: args[1] };
  } else if (
    args.length === 3 &&
    args[0] === "--tag" &&
    args[1].length > 0 &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(args[2])
  ) {
    mode = { type: "tag", name: args[1], sha: args[2] };
  } else if (args.length === 1 && args[0] === "--history") {
    mode = { type: "history" };
  } else {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    const rules = { deny: loadDenylist(), liveKey: loadLiveKey() };
    let hits;
    if (mode.type === "staged") {
      const diff = runGit(["diff", "--cached", "-U0", "--text", "--no-color", "--no-ext-diff"]);
      hits = scanAddedLines(diff, rules, scanText);
    } else if (mode.type === "push") {
      const log = runGit([
        "log",
        "-p",
        "--text",
        "--diff-merges=first-parent",
        "--format=fuller",
        "--no-color",
        "--no-ext-diff",
        "--no-notes",
        mode.range,
        "--",
      ]);
      hits = scanLogOutput(log, rules);
    } else if (mode.type === "tag") {
      hits = scanTagMessage(mode.name, mode.sha, rules, scanText, runGit);
    } else {
      const log = runGit([
        "log",
        "-p",
        "--text",
        "--diff-merges=first-parent",
        "--format=fuller",
        "--no-color",
        "--no-ext-diff",
        "--no-notes",
        "--all",
        "--",
      ]);
      hits = [
        ...scanLogOutput(log, rules),
        ...scanAllTagMessages(rules, scanText, runGit),
      ];
    }

    for (const hit of hits) {
      process.stdout.write(`${formatPath(hit.path, rules)}:${hit.line} ${hit.rule}\n`);
    }
    process.exitCode = hits.length > 0 ? 1 : 0;
  } catch {
    process.stderr.write("privacy-scan: scan failed\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
