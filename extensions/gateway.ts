import packageInfo from "../package.json" with { type: "json" };
import type { HubConfig } from "./config.ts";
import { redact } from "./redact.ts";

const USER_AGENT = `pi-litellm-hub/${packageInfo.version}`;
const ERROR_BODY_LIMIT = 4096;

function redactedError(message: string, apiKey: string): Error {
  return new Error(redact(message, apiKey));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function timedOut(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || isAbortError(error);
}

function timeoutError(path: string, timeoutMs: number, apiKey: string): Error {
  return redactedError(`gateway ${path} timed out after ${timeoutMs / 1000}s`, apiKey);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let stoppedEarly = false;
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = value.slice(0, maxBytes - bytesRead);
      chunks.push(chunk);
      bytesRead += chunk.byteLength;
      if (bytesRead === maxBytes) {
        stoppedEarly = true;
        break;
      }
    }
  } finally {
    if (stoppedEarly) {
      try {
        await reader.cancel();
      } catch {
        // A failed cancellation must not replace the bounded HTTP error below.
      }
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function gatewayGetJson(
  cfg: HubConfig,
  apiKey: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10000,
): Promise<unknown> {
  const requestPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${requestPath}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (timedOut(signal, error)) throw timeoutError(requestPath, timeoutMs, apiKey);
    throw redactedError(`gateway ${requestPath} request failed: ${errorMessage(error)}`, apiKey);
  }
  if (signal.aborted) throw timeoutError(requestPath, timeoutMs, apiKey);

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw redactedError("redirect refused (3xx)", apiKey);
  }

  if (response.status < 200 || response.status >= 300) {
    let body = "";
    try {
      body = await readBoundedBody(response, ERROR_BODY_LIMIT);
    } catch (error) {
      if (timedOut(signal, error)) throw timeoutError(requestPath, timeoutMs, apiKey);
      // The status remains useful even when a failed response body cannot be read.
    }
    if (signal.aborted) throw timeoutError(requestPath, timeoutMs, apiKey);
    throw redactedError(
      `gateway ${requestPath} returned ${response.status}: ${body.slice(0, 200)}`,
      apiKey,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (timedOut(signal, error)) throw timeoutError(requestPath, timeoutMs, apiKey);
    throw redactedError(`gateway ${requestPath} returned invalid JSON`, apiKey);
  }
  if (signal.aborted) throw timeoutError(requestPath, timeoutMs, apiKey);
  return payload;
}

export type GatewayPriceField = "input" | "output" | "cacheRead" | "cacheWrite";
// Prices use pi's cost unit: USD per million tokens.
export type GatewayPrices = Partial<Record<GatewayPriceField, number>>;

export type GatewayModel = {
  id: string;
  mode?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  prices?: GatewayPrices;
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function fetchGatewayModels(
  cfg: HubConfig,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayModel[]> {
  const payload = await gatewayGetJson(cfg, apiKey, "/v1/models", fetchImpl);
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw redactedError("gateway /v1/models returned an invalid model list", apiKey);
  }
  return payload.data.flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const maxInputTokens = positiveInteger(item.max_input_tokens);
    const maxOutputTokens = positiveInteger(item.max_output_tokens);
    return [{
      id: item.id,
      ...(typeof item.mode === "string" ? { mode: item.mode } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
