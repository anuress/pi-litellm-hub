function decodeGitQuotedPath(quotedPath) {
  const bytes = [];
  const end = quotedPath.length - 1;
  const escapes = { '"': 34, "\\": 92, a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

  for (let index = 1; index < end; index += 1) {
    if (quotedPath[index] !== "\\") {
      const value = String.fromCodePoint(quotedPath.codePointAt(index));
      bytes.push(...Buffer.from(value));
      index += value.length - 1;
      continue;
    }

    const escaped = quotedPath[++index];
    if (/[0-7]/.test(escaped ?? "")) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(quotedPath[index + 1] ?? "")) octal += quotedPath[++index];
      bytes.push(Number.parseInt(octal, 8));
    } else if (Object.hasOwn(escapes, escaped)) bytes.push(escapes[escaped]);
    else if (escaped !== undefined) bytes.push(...Buffer.from(escaped));
  }

  return Buffer.from(bytes).toString("utf8");
}

function parseAddedPath(header) {
  const rawPath = header.startsWith('"') ? decodeGitQuotedPath(header) : header;
  if (rawPath === "/dev/null") return null;
  return rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath;
}

export function scanAddedLines(patch, rules, scanText) {
  const hits = [];
  let path = null;
  let newLine = null;
  let inHunk = false;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      path = null;
      newLine = null;
      inHunk = false;
      continue;
    }

    if (!inHunk && line.startsWith("+++ ")) {
      path = parseAddedPath(line.slice(4));
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("+")) {
      if (path !== null && newLine !== null) {
        for (const hit of scanText(line.slice(1), rules)) {
          hits.push({ path, line: newLine + hit.line - 1, rule: hit.rule });
        }
      }
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Removed lines do not exist in the new tree and are not scanned here.
    } else if (line.startsWith(" ")) {
      newLine += 1;
    } else if (line.startsWith("\\ No newline at end of file")) {
      // This marker is patch metadata, not source content.
    } else {
      inHunk = false;
      newLine = null;
    }
  }

  return hits;
}

export function scanTagMessage(name, sha, rules, scanText, runGit) {
  if (runGit(["cat-file", "-t", sha]).trim() !== "tag") return [];

  const tagObject = runGit(["cat-file", "-p", sha]);
  const headerEnd = tagObject.indexOf("\n\n");
  if (headerEnd < 0) return [];

  return scanText(tagObject.slice(headerEnd + 2), rules).map((hit) => ({
    path: `tag:${name}`,
    line: hit.line,
    rule: hit.rule,
  }));
}

export function scanAllTagMessages(rules, scanText, runGit) {
  const refs = runGit([
    "for-each-ref",
    "--format=%(refname:strip=2)%09%(objectname)",
    "refs/tags",
  ]);
  const hits = [];

  for (const ref of refs.split(/\r?\n/)) {
    const separator = ref.indexOf("\t");
    if (separator < 0) continue;
    const name = ref.slice(0, separator);
    const sha = ref.slice(separator + 1);
    if (name && sha) hits.push(...scanTagMessage(name, sha, rules, scanText, runGit));
  }

  return hits;
}
