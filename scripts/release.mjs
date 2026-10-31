import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateReleaseNotes } from "./release-notes.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function errorMessage(error) {
  return error?.stderr?.toString().trim() || error?.message || "unknown error";
}

function validVersion(version) {
  const match = typeof version === "string" && SEMVER.exec(version);
  if (!match || match[0] !== version) return false;
  const prerelease = match[4];
  return !prerelease || prerelease.split(".").every((identifier) =>
    !/^\d+$/.test(identifier) || identifier.length === 1 || !identifier.startsWith("0"));
}

export function createRelease(version) {
  if (!validVersion(version)) throw new Error("version must be a valid semantic version");

  const root = runGit(["rev-parse", "--show-toplevel"]).trim();
  process.chdir(root);
  if (runGit(["branch", "--show-current"]).trim() !== "main") {
    throw new Error("release must run on the main branch");
  }
  if (runGit(["status", "--porcelain", "--untracked-files=all"]).trim()) {
    throw new Error("working tree must be clean");
  }

  const tag = `v${version}`;
  try {
    runGit(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]);
    throw new Error(`tag ${tag} already exists`);
  } catch (error) {
    if (error?.status !== 1) throw error;
  }

  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error("package.json must contain a JSON object");
  }
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  runGit(["add", "--", "package.json"]);
  runGit(["commit", "-m", `chore: release ${version}`]);
  const notes = generateReleaseNotes("HEAD");
  runGit(["tag", "-a", tag, "-m", `${tag}\n\n${notes}`]);
  process.stdout.write(`git push origin main ${tag}\n`);
}

function main(args) {
  if (args.length !== 1) {
    process.stderr.write("Usage: npm run release -- <version>\n");
    process.exitCode = 2;
    return;
  }

  try {
    createRelease(args[0]);
  } catch (error) {
    process.stderr.write(`release: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
