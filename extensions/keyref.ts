import { execSync } from "node:child_process";

function runShell(command: string): string {
  return execSync(command, {
    encoding: "utf8",
    shell: "/bin/sh",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
}

export function resolveKeyRef(
  ref: string,
  env: Record<string, string | undefined>,
  run: (command: string) => string = runShell,
): string | undefined {
  try {
    // Pi command references contain the shell command after the leading marker.
    if (ref.startsWith("!")) return run(ref.slice(1)).trim();

    // Expand only complete environment references; other strings remain literal values.
    const variable = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(ref);
    if (variable) return env[variable[1] ?? variable[2]];
    return ref;
  } catch {
    return undefined;
  }
}
