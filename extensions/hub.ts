import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type HubConfig } from "./config.ts";
import { fetchGatewayIds } from "./gateway.ts";
import { matchModels, type Catalog, type MatchedModel, type Skipped } from "./models.ts";
import { redact } from "./redact.ts";
import { newHubState, renderModelReport, updateStatus, type HubState } from "./status.ts";
import { resolveKeyRef } from "./keyref.ts";

export type HubDependencies = {
  pi: ExtensionAPI;
  env: Record<string, string | undefined>;
  home: string;
  fetchImpl: typeof fetch;
  catalog: Catalog;
  resolveKey: typeof resolveKeyRef;
};

type Discovery = { models: MatchedModel[]; skipped: Skipped[] };

function errorText(error: unknown, key?: string): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return redact(message || "gateway request failed", key);
  } catch {
    return "gateway request failed";
  }
}

function providerModels(models: MatchedModel[], config: HubConfig): any[] {
  // Pi's Anthropic Messages client expects the API root and appends /v1/messages itself.
  return models.map(({ api, model }) => {
    const { baseUrl: _catalogBaseUrl, ...definition } = model;
    return api === "anthropic-messages" ? { ...definition, baseUrl: config.baseUrl } : definition;
  });
}

export async function createHub(deps: HubDependencies): Promise<HubState> {
  const { pi, env, home, fetchImpl, catalog, resolveKey } = deps;
  const state = newHubState();
  let config: HubConfig | undefined;
  let apiKey: string | undefined;

  const notify = (
    ctx: Pick<ExtensionContext, "ui" | "hasUI">,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ) => {
    if (ctx.hasUI) ctx.ui.notify(redact(message, apiKey), type);
  };

  const selectModel = (model: { id?: string; provider?: string } | undefined, thinking?: string) => {
    if (model?.provider === "litellm" && model.id) {
      state.activeModelId = model.id;
      state.thinking = thinking;
    } else {
      state.activeModelId = undefined;
      state.thinking = undefined;
    }
  };

  const discover = async (signal?: AbortSignal): Promise<Discovery> => {
    if (!config || !apiKey) throw new Error("no gateway configuration");
    // Preserve both Pi's refresh cancellation and the gateway helper's own timeout signal.
    const requestFetch: typeof fetch = signal
      ? (input, init) => {
          const requestSignal = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
          return fetchImpl(input, { ...init, signal: requestSignal });
        }
      : fetchImpl;
    const ids = await fetchGatewayIds(config, apiKey, requestFetch);
    return matchModels(ids, catalog);
  };

  const installProvider = (result: Discovery) => {
    if (!config) throw new Error("no gateway configuration");
    pi.registerProvider("litellm", {
      baseUrl: `${config.baseUrl.replace(/\/+$/, "")}/v1`,
      // Pi resolves this reference for model calls; the resolved key stays local to gateway fetches.
      apiKey: config.apiKeyRef,
      models: providerModels(result.models, config),
      // Legacy ProviderConfig refresh replaces the provider's models with the returned list.
      refreshModels: async ({ signal }) => {
        let refreshed: Discovery;
        try {
          refreshed = await discover(signal);
        } catch (error) {
          if (signal.aborted) throw new Error("gateway refresh aborted");
          const reason = errorText(error, apiKey);
          state.reason = reason;
          throw new Error(reason);
        }
        if (signal.aborted) throw new Error("gateway refresh aborted");
        state.models = refreshed.models;
        state.skipped = refreshed.skipped;
        state.reason = undefined;
        return providerModels(refreshed.models, config);
      },
    });
    state.models = result.models;
    state.skipped = result.skipped;
    state.reason = undefined;
  };

  const refresh = async (ctx: ExtensionCommandContext) => {
    if (!config || !apiKey) {
      notify(ctx, `refresh failed: ${state.notConfigured ?? "no key"}`, "error");
      return;
    }
    try {
      const result = await discover(ctx.signal);
      installProvider(result);
      updateStatus(ctx, state, apiKey);
      notify(ctx, `refreshed: ${result.models.length} models`);
    } catch (error) {
      state.reason = errorText(error, apiKey);
      updateStatus(ctx, state, apiKey);
      notify(ctx, `refresh failed: ${state.reason}`, "error");
    }
  };

  pi.registerCommand("litellm", {
    description: "Show LiteLLM models or refresh the gateway catalog",
    handler: async (args, ctx) => {
      if (args.trim() === "refresh") await refresh(ctx);
      else notify(ctx, renderModelReport(state));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    selectModel(ctx.model, ctx.thinkingLevel);
    updateStatus(ctx, state, apiKey);
    const notice = state.notConfigured ?? state.reason;
    if (notice) setTimeout(() => notify(ctx, `litellm: ${notice}`, "warning"), 0);
  });

  pi.on("model_select", (event, ctx) => {
    selectModel(event.model, ctx.thinkingLevel);
    updateStatus(ctx, state, apiKey);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (state.activeModelId) state.thinking = event.level;
    updateStatus(ctx, state, apiKey);
  });

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(env, home);
  } catch {
    state.notConfigured = "configuration unavailable";
    return state;
  }
  if (!loaded.ok) {
    state.notConfigured = loaded.reason;
    return state;
  }

  config = loaded.config;
  state.config = config;
  try {
    apiKey = resolveKey(config.apiKeyRef, env);
  } catch {
    apiKey = undefined;
  }
  if (!apiKey) {
    state.notConfigured = "no key";
    return state;
  }

  try {
    installProvider(await discover());
  } catch (error) {
    state.reason = errorText(error, apiKey);
  }
  return state;
}
