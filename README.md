# pi-litellm-hub

A small pi extension for one LiteLLM gateway. It discovers gateway model IDs, matches them to pi's built-in model catalog for thinking-level support, uses pi's OpenAI and Anthropic protocols, and explains spend, caching, and failures in the status line.

## Requirements

- pi 1.4.0; its `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` peer dependencies are supplied by pi
- Node.js 22.19 or newer
- MIT licensed; no runtime dependencies

## Install and configure

Add the checkout to the global `~/.pi/agent/settings.json`. Merge these properties into your existing file, replacing the package path with the checkout's absolute path:

```json
{
  "packages": ["/absolute/path/to/pi-litellm-hub"],
  "litellmHub": {
    "baseUrl": "https://litellm.example.com"
  }
}
```

The top-level `packages` list loads this pi package; `package.json` declares `"pi": { "extensions": ["./extensions/index.ts"] }`. Configuration is global only; project-level `.pi/settings.json` files are ignored. There is no default gateway URL. A non-empty `LITELLM_BASE_URL` overrides `litellmHub.baseUrl`:

```sh
export LITELLM_BASE_URL='https://litellm.example.com'
```

Store the API key in pi's credential file, `~/.pi/agent/auth.json`, under provider `litellm` (the extension accepts `key`, `apiKey`, or `access`):

```json
{
  "litellm": { "type": "api_key", "key": "sk-..." }
}
```

Keep that file private (`chmod 600 ~/.pi/agent/auth.json`) and out of any dotfiles repository. The extension also accepts the key from the `LITELLM_API_KEY` environment variable, which takes precedence. For model calls, pi receives a reference (`$LITELLM_API_KEY`, or a `!node -e` command that reads `auth.json`) and resolves it at request time; the hub resolves the credential at startup for its own gateway lookups. The raw key is never copied into provider or model definitions.

Use the gateway root URL. HTTPS is required except for `http://localhost` and `http://127.0.0.1`; URL userinfo (`user:password@`) is rejected. A trailing slash or `/v1` suffix is normalized away.

## Use and debug

Gateway models are discovered from `/v1/models` and registered as provider `litellm`. Matched models use pi's built-in `anthropic-messages`, `openai-responses`, or `openai-completions` API. From the catalog entry the hub takes only the model description (name, reasoning, input types, cost, limits), the thinking levels, and model-specific flags such as Claude's adaptive thinking; it never inherits features of a provider's own API (such as OpenAI tool search), which the gateway does not forward. Gateway metadata also informs limits and filtering: a positive-integer `max_input_tokens` can only lower a catalog model's context window, while its catalog output limit is preserved. Unknown models use reported positive-integer input/output limits in place of the conservative defaults; missing limits keep those defaults. Explicit modes other than `chat`/`responses` are skipped, and the existing ID filter is used only when mode is absent. LiteLLM requests carry a `pi-litellm-hub/<version>` User-Agent and the current session ID in `x-litellm-session-id`. Select a discovered model in pi, or start pi with a model such as `litellm/MODEL_ID:LEVEL`.

- `/litellm` lists matched model IDs, API, thinking levels, catalog source, and any model reason; it also lists skipped IDs and reasons, plus the last Claude cache result when available.
- `/litellm refresh` fetches the catalog again. If it fails, the existing model list is kept and the failure is shown.

The status line normally shows the model, thinking level, session cost, and key spend/budget window, for example `litellm · MODEL_ID · thinking high · session $X · month $X/$Y (resets Mon D)`. A missing thinking selection is shown as `default`; a non-month window (for example `7d`) keeps its label. If a turn has only an estimate, the session amount is prefixed with `~` and marked `(est.)`; once estimated, the session stays marked estimated. A failure reason replaces the normal status tail. Gateway fallback and retry headers add `fallback` and `retry×N` markers for the latest turn; absent or invalid headers add no marker.

### Spend and Claude caching

OpenAI Responses cost is read from the `response.completed` stream event. Streamed Chat Completions requests ask for `include_usage` so the final chunk can provide cost. Claude streams do not carry gateway cost, so those turns use pi's estimate. Key spend and budget come from the `x-litellm-key-spend` and `x-litellm-key-max-budget` response headers; the displayed spend adds the current turn to the spend observed before that request. `/key/info` supplies only the reset date and window.

Claude uses `/v1/messages` via `anthropic-messages`. Cache markers pass through unchanged: caching is controlled by the gateway, and the hub only reports cache reads/writes (`cache: hit (read …)` or `cache: miss (wrote …, read 0)`). It shows a warning after two consecutive Claude cache misses (`cache: missed 2 turns in row (gateway caching may be off)`). There is no `litellmHub.claudeCache` setting.

### Reasons you may see

- Configuration: `not configured: no gateway URL`, `not configured: no key`, `not configured: configuration unavailable`, `not configured: gateway URL is not a valid URL`, `not configured: gateway URL must not contain credentials`, or `not configured: gateway URL must be https`.
- Model/catalog reasons in `/litellm`: `not in pi's catalog`, `ambiguous catalog match`, `model does not reason`, `catalog lists no effort levels`, `kimi needs its own thinking switch`, or `deepseek needs its own thinking switch`. A skipped non-chat model is labeled `not a chat model`.
- Cache warning: `cache: missed 2 turns in row (gateway caching may be off)`.
- Failures: `failed: out of budget (...)`, `failed: gateway busy (parallel request limit)`, `failed: key not allowed to call <route>; ask the gateway admin` for route-scoped key 403s, `failed: blocked by Cloudflare (1010), not a key problem`, `failed: gateway error inside a 200 response: ...`, or the fallback `failed: <short message>` for other errors.

Pi does not retry a budget HTTP 400; it may retry a 429 up to three times by default. The extension cannot stop pi's retries.

## Events for other extensions

The hub emits `litellm-hub:state` on status updates with `configured`, `model`, `thinkingLevel`, `levelsAvailable`, `reason`, `sessionCost`, `sessionEstimated`, `keySpend`, `keyBudget`, `attemptedFallbacks`, `attemptedRetries`, `resetAt`, `window`, `lastCache`, `modelsMatched`, `modelsSkipped`, and `at`. Optional values may be absent. Emit `litellm-hub:request` to request the current snapshot. Failures emit `litellm-hub:failure` with `{ model, reason, at }`.

In another extension, listen before requesting the initial snapshot:

```ts
pi.events.on("litellm-hub:state", (snapshot) => console.log(snapshot));
pi.events.on("litellm-hub:failure", ({ model, reason, at }) => console.log({ model, reason, at }));
pi.events.emit("litellm-hub:request", {});
```

Published strings are redacted. The events never publish the key, gateway URL or host, request headers, or config.

## Security and privacy hooks

Status text, `/litellm` output, notifications, and published event strings redact the API key and key-shaped `sk-…` strings, strip URL userinfo, and replace the configured gateway hostname with `<gateway>`. The hub's own `/v1/models` and `/key/info` requests refuse redirects, time out after 10 seconds, and bound error-body reads to 4 KiB.

Enable the checkout's local privacy hooks:

```sh
git config core.hooksPath .githooks
```

The pre-commit hook scans staged additions; pre-push scans the commits being pushed. The local denylist belongs in `.git/info/privacy-denylist` and is never committed. Scan history with:

```sh
node scripts/privacy-scan.mjs --history
```

## Development

Run the tests with `node --test test/`. The extension is TypeScript loaded directly by pi; no build step is required.
