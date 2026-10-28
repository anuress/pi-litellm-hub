import { readFileSync } from "node:fs";
import { join } from "node:path";

export type HubConfig = {
  baseUrl: string;
  apiKeyRef: string;
  claudeCache: boolean;
};

type BaseUrlResult =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  // JSON arrays and primitives cannot hold the named settings fields we consume.
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    // Missing files and malformed JSON both mean that this source is absent.
    return undefined;
  }
}

function normalizeBaseUrl(value: unknown): BaseUrlResult {
  // An empty configured value is reported as missing instead of being passed to URL parsing.
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: "no gateway URL" };
  }

  // Normalize only the gateway root suffix; the rest of the configured path is preserved.
  let baseUrl = value.trim().replace(/\/+$/, "");
  if (baseUrl.endsWith("/v1")) baseUrl = baseUrl.slice(0, -3);

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Keep parsing failures distinct from syntactically valid but insecure URLs.
    return { ok: false, reason: "gateway URL is not a valid URL" };
  }

  // Permit cleartext HTTP only for the two explicitly approved loopback hostnames.
  const isLocalHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    return { ok: false, reason: "gateway URL must be https" };
  }

  return { ok: true, baseUrl };
}

function hasStoredApiKey(home: string): boolean {
  // Read credentials only to establish that a usable field exists; never return its value.
  const auth = asRecord(readJson(join(home, ".pi", "agent", "auth.json")));
  const litellm = asRecord(auth?.litellm);
  const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

  return (
    isNonEmptyString(litellm?.key) ||
    isNonEmptyString(litellm?.apiKey) ||
    isNonEmptyString(litellm?.access)
  );
}

function shellQuote(value: string): string {
  // Pi executes !command through a shell; escape single quotes without shell expansion.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function storedApiKeyCommand(home: string): string {
  // Keep the credential out of command text; the command reads it from the auth file when resolved.
  const authPath = join(home, ".pi", "agent", "auth.json");
  const source = [
    `const auth=JSON.parse(require("node:fs").readFileSync(${JSON.stringify(authPath)},"utf8"));`,
    "const credentials=auth?.litellm??{};",
    'const key=[credentials.key,credentials.apiKey,credentials.access].find(value=>typeof value==="string"&&value.length>0);',
    "if(key)process.stdout.write(key);",
  ].join("");

  return `!node -e ${shellQuote(source)}`;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  home: string,
): { ok: true; config: HubConfig } | { ok: false; reason: string } {
  const settings = asRecord(readJson(join(home, ".pi", "agent", "settings.json")));
  const hubSettings = asRecord(settings?.litellmHub);
  // Environment configuration overrides the global settings file when it is non-blank.
  const envBaseUrl = env.LITELLM_BASE_URL;
  const rawBaseUrl =
    typeof envBaseUrl === "string" && envBaseUrl.trim().length > 0
      ? envBaseUrl
      : hubSettings?.baseUrl;
  const baseUrlResult = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrlResult.ok) return baseUrlResult;

  // Keep credentials as a Pi reference instead of placing secret material in the config.
  const envApiKey = env.LITELLM_API_KEY;
  let apiKeyRef: string;
  if (typeof envApiKey === "string" && envApiKey.length > 0) {
    apiKeyRef = "$LITELLM_API_KEY";
  } else if (hasStoredApiKey(home)) {
    apiKeyRef = storedApiKeyCommand(home);
  } else {
    return { ok: false, reason: "no key" };
  }

  return {
    ok: true,
    config: {
      baseUrl: baseUrlResult.baseUrl,
      apiKeyRef,
      claudeCache: hubSettings?.claudeCache === true,
    },
  };
}
