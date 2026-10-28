import type { HubConfig } from "./config.ts";
import type { MatchedModel, Skipped } from "./models.ts";
import { redact } from "./redact.ts";

export type HubState = {
  config?: HubConfig;
  models: MatchedModel[];
  skipped: Skipped[];
  activeModelId?: string;
  thinking?: string;
  reason?: string;
  sessionCost: number;
  sessionEstimated: boolean;
  keySpend?: number;
  keyBudget?: number;
  lastCache?: string;
  resetAt?: string;
  window?: string;
  notConfigured?: string;
};

type StatusBinding = {
  key?: string;
  host?: string;
  emit?: (channel: string, data: unknown) => void;
};

// Keep secrets and the event publisher outside HubState, whose fields are otherwise easy to spread.
const statusBindings = new WeakMap<HubState, StatusBinding>();

export function bindStatus(state: HubState, binding: StatusBinding): void {
  statusBindings.set(state, binding);
}

export function hubSnapshot(
  state: HubState,
  binding: Pick<StatusBinding, "key" | "host">,
) {
  const activeModel = state.models.find((model) => model.id === state.activeModelId);
  const reason = state.reason ?? state.notConfigured;
  // Model metadata and error strings are external text, so sanitize every published string field.
  const safeText = (value: string | undefined) =>
    value === undefined ? undefined : redact(value, binding.key, binding.host);

  // Keep the event shape explicit: HubState also contains config, including the gateway URL.
  return {
    configured: !state.notConfigured,
    model: safeText(state.activeModelId),
    thinkingLevel: safeText(state.thinking),
    levelsAvailable: activeModel &&
      supportedLevels(activeModel).map((level) => redact(level, binding.key, binding.host)),
    reason: safeText(reason),
    sessionCost: state.sessionCost,
    sessionEstimated: state.sessionEstimated,
    keySpend: state.keySpend,
    keyBudget: state.keyBudget,
    resetAt: safeText(state.resetAt),
    window: safeText(state.window),
    lastCache: safeText(state.lastCache),
    modelsMatched: state.models.length,
    modelsSkipped: state.skipped.length,
    at: new Date().toISOString(),
  };
}

export function publishFailure(state: HubState, model: string | undefined, reason: string): void {
  const binding = statusBindings.get(state);
  if (!binding?.emit) return;

  binding.emit("litellm-hub:failure", {
    model: model === undefined ? undefined : redact(model, binding.key, binding.host),
    reason: redact(reason, binding.key, binding.host),
    at: new Date().toISOString(),
  });
}

const resetDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function formatResetDate(resetAt: string): string | undefined {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return resetDateFormatter.format(date);
}

export function newHubState(): HubState {
  return { models: [], skipped: [], sessionCost: 0, sessionEstimated: false };
}

function spendSegment(state: HubState): string {
  // Missing spend data is not the same as a zero balance.
  if (state.keySpend === undefined) return "";

  // The gateway's 30-day window is presented as the familiar monthly label.
  const window = state.window === undefined || state.window === "30d" ? "month" : state.window;
  const budget = state.keyBudget === undefined ? "?" : state.keyBudget.toFixed(0);
  let segment = `${window} $${state.keySpend.toFixed(2)}/$${budget}`;
  if (state.resetAt) {
    // The shared formatter keeps status and failure reasons on the same UTC calendar day.
    const resetDate = formatResetDate(state.resetAt);
    if (resetDate) segment += ` (resets ${resetDate})`;
  }
  return ` · ${segment}`;
}

export function renderStatus(state: HubState): string {
  // Configuration errors take precedence over empty model and spend data.
  if (state.notConfigured) return `litellm · not configured: ${state.notConfigured}`;

  if (state.activeModelId) {
    const model = `litellm · ${state.activeModelId}`;
    // A failure reason replaces the normal model tail instead of hiding the failure.
    if (state.reason) return `${model} · ${state.reason}`;

    const thinking = state.thinking ?? "default";
    const estimate = state.sessionEstimated ? "~" : "";
    const estimatedLabel = state.sessionEstimated ? " (est.)" : "";
    const session = `session ${estimate}$${state.sessionCost.toFixed(2)}${estimatedLabel}`;
    return `${model} · thinking ${thinking} · ${session}${spendSegment(state)}`;
  }

  // Without an active model, retain the catalog count while making startup failures visible.
  const count = `litellm · ${state.models.length} models`;
  const reason = state.reason ? ` · ${state.reason}` : "";
  return `${count}${reason}${spendSegment(state)}`;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Mirrors pi-ai getSupportedThinkingLevels (dist/models.js); not imported to keep pi-ai out of runtime.
export function supportedLevels(model: MatchedModel): string[] {
  if (!model.model.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.levels?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function levelsLabel(model: MatchedModel): string {
  const levels = supportedLevels(model).join(", ");
  // No map deliberately leaves pi's own thinking defaults in control.
  return model.levels === undefined ? `${levels} (pi default)` : levels;
}

export function renderModelReport(state: HubState): string {
  const lines = [`LiteLLM models: ${state.models.length} matched, ${state.skipped.length} skipped`];
  for (const model of state.models) {
    const fields = [model.id, model.api, levelsLabel(model), model.catalogSource ?? "unknown"];
    if (model.reason) fields.push(model.reason);
    lines.push(`- ${fields.join(" | ")}`);
  }

  if (state.lastCache !== undefined) lines.push(`Last Claude cache: ${state.lastCache}`);

  lines.push("Skipped:");
  if (state.skipped.length === 0) lines.push("- none");
  else lines.push(...state.skipped.map(({ id, reason }) => `- ${id} — ${reason}`));
  return lines.join("\n");
}

export function updateStatus(
  ctx: { ui: { setStatus(key: string, text: string | undefined): void } },
  state: HubState,
  key?: string,
): void {
  const binding = statusBindings.get(state);
  const statusKey = key === undefined ? binding?.key : key;
  ctx.ui.setStatus("litellm", redact(renderStatus(state), statusKey, binding?.host));
  binding?.emit?.("litellm-hub:state", hubSnapshot(state, binding));
}
