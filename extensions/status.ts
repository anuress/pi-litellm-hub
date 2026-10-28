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
  claudeCacheDisabled?: boolean;
  resetAt?: string;
  window?: string;
  notConfigured?: string;
};

const resetDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

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
    const resetDate = new Date(state.resetAt);
    // UTC avoids rendering a different calendar day on machines in other time zones.
    if (!Number.isNaN(resetDate.getTime())) {
      segment += ` (resets ${resetDateFormatter.format(resetDate)})`;
    }
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

function levelsLabel(model: MatchedModel): string {
  // No map deliberately leaves pi's own thinking defaults in control.
  if (model.levels === undefined) return "pi default";
  const levels = Object.keys(model.levels).filter((level) => model.levels?.[level] !== null);
  return levels.length ? levels.join(", ") : "none";
}

export function renderModelReport(state: HubState): string {
  const lines = [`LiteLLM models: ${state.models.length} matched, ${state.skipped.length} skipped`];
  for (const model of state.models) {
    const fields = [model.id, model.api, levelsLabel(model), model.catalogSource ?? "unknown"];
    if (model.reason) fields.push(model.reason);
    lines.push(`- ${fields.join(" | ")}`);
  }

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
  ctx.ui.setStatus("litellm", redact(renderStatus(state), key));
}
