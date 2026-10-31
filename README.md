# pi-litellm-hub

A small pi extension for one LiteLLM gateway. It discovers gateway model IDs, matches them to pi's built-in model catalog for thinking-level support, uses pi's OpenAI and Anthropic protocols, and explains spend, caching, and failures in the status line. It is built for LiteLLM virtual keys that may not be allowed to read `/model/info`; when both metadata routes are unavailable, it falls back to `/v1/models` plus pi's catalog.

## Requirements

- pi 1.4.0; its `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` peer dependencies are supplied by pi
- Node.js 22.19 or newer
- MIT licensed; no runtime dependencies

## Install and configure

Install the package globally:

```sh
pi install npm:pi-litellm-hub
```

This adds `"npm:pi-litellm-hub"` to the top-level `packages` list in `~/.pi/agent/settings.json`. For development from a local checkout, use the checkout's absolute path (for example, `/absolute/path/to/pi-litellm-hub`) instead.

Add the gateway configuration to that file, merging it with your existing settings:

```json
{
  "litellmHub": {
    "baseUrl": "https://litellm.example.com",
    "claudeCacheWarming": false
  }
}
```

`claudeCacheWarming` defaults to `false`; set it to `true` only if the gateway returns cache reads. Each warm-up writes to the cache, so check `/litellm` or the cache hit/miss line first.

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

## Use

Select a `litellm/...` model in pi, or start pi with `litellm/MODEL_ID:LEVEL`. The status line shows the model, thinking level, session cost and key budget, for example `litellm · MODEL_ID · thinking high · session $0.12 · budget $40.00/$200 (resets Nov 1)`. A `~` and `(est.)` mark a session cost that includes pi's estimate (Claude turns; the gateway reports no cost for them). If a request fails, a short reason replaces the tail of the line.

- `/litellm` lists matched and skipped models with their API, thinking levels and rate source, plus the last Claude cache result.
- `/litellm refresh` repeats gateway model discovery and keeps the current list if it fails.

Model limits and rates come from the gateway's `/model_group/info` or `/model/info` when the key may read them, otherwise from `/v1/models` plus pi's catalog. Thinking levels always come from pi's catalog.

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

Run the tests with `npm test`. The extension is TypeScript loaded directly by pi; no build step is required.

## Release

One-time setup: configure npm trusted publishing for `anuress/pi-litellm-hub` with workflow `publish.yml` on npmjs.com.
For each release, run `npm run release -- 0.2.0` (replace with the new version), then push both the commit and tag with `git push origin main v0.2.0` (use the same version). The command updates `package.json`, creates the `chore: release` commit, and adds an annotated `v0.2.0` tag whose message contains the changelog. GitHub Actions publishes the package to npm with provenance and copies the tag notes into a GitHub Release; older lightweight tags fall back to generated notes. No npm token secret is used.

## Planned

- Keep the last discovered model list so pi can still offer LiteLLM models if the gateway is unreachable at startup.
- Optionally use models.dev metadata for limits and prices when models are missing from pi's catalog.
