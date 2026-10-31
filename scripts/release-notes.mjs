import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function errorMessage(error) {
  return error?.stderr?.toString().trim() || error?.message || "unknown error";
}

export function generateReleaseNotes(targetRef = "HEAD") {
  if (typeof targetRef !== "string" || targetRef.length === 0 || targetRef.startsWith("-")) {
    throw new Error("target ref must be a non-empty Git ref");
  }

  const target = runGit(["rev-parse", "--verify", `${targetRef}^{commit}`]).trim();
  let range = target;
  try {
    const previousTag = runGit(["describe", "--tags", "--abbrev=0", `${target}^`]).trim();
    range = `${previousTag}..${target}`;
  } catch (error) {
    if (error?.status !== 128) throw error;
  }

  const commits = runGit([
    "log",
    "--no-merges",
    "--no-color",
    "--format=%s%x00%h",
    range,
    "--",
  ]);
  const notes = [];
  for (const commit of commits.split("\n")) {
    if (!commit) continue;
    const separator = commit.indexOf("\0");
    if (separator < 0) throw new Error("git log returned an invalid commit record");
    const subject = commit.slice(0, separator);
    if (subject.startsWith("chore: release")) continue;
    notes.push(`- ${subject} (${commit.slice(separator + 1)})`);
  }

  return notes.length > 0 ? notes.join("\n") : "- No changes listed.";
}

function main(args) {
  if (
    (args.length !== 1 && args.length !== 3) ||
    args[0].startsWith("-") ||
    (args.length === 3 && (args[1] !== "--to" || args[2].startsWith("-")))
  ) {
    process.stderr.write("Usage: node scripts/release-notes.mjs <tag> [--to <ref>]\n");
    process.exitCode = 2;
    return;
  }

  const targetRef = args.length === 3 ? args[2] : args[0];
  try {
    process.stdout.write(`${generateReleaseNotes(targetRef)}\n`);
  } catch (error) {
    process.stderr.write(`release-notes: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
