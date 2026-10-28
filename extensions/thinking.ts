export type ThinkingResult = {
  levels?: Record<string, string | null>;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, any> {
  // Arrays and null cannot carry the named catalog settings used here.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasThinkingCarrier(catalogModel: Record<string, any>): boolean {
  const compat = catalogModel.compat;
  // A family-specific carrier must be named, not merely enabled by a generic support flag.
  if (!isRecord(compat)) return false;

  return (
    (typeof compat.thinkingFormat === "string" && compat.thinkingFormat.length > 0) ||
    (typeof compat.thinkingTokenBudgetField === "string" && compat.thinkingTokenBudgetField.length > 0)
  );
}

function thinkingFamily(id: string, catalogId: unknown): "kimi" | "deepseek" | undefined {
  const identifiers = [id, typeof catalogId === "string" ? catalogId : ""];
  for (const identifier of identifiers) {
    const normalized = identifier.toLowerCase();
    // Match either the gateway id or the catalog id to detect vendor-prefixed aliases.
    if (normalized.includes("kimi")) return "kimi";
    if (normalized.includes("deepseek")) return "deepseek";
  }
  return undefined;
}

export function thinkingFor(
  catalogModel: Record<string, any> | undefined,
  id: string,
): ThinkingResult {
  // Return a concrete explanation for absent or non-reasoning catalog entries.
  if (!catalogModel) return { reason: "not in pi's catalog" };
  if (catalogModel.reasoning !== true) return { reason: "model does not reason" };

  const family = thinkingFamily(id, catalogModel.id);
  // Do not expose generic effort controls for families that lack an explicit wire carrier.
  if (family && !hasThinkingCarrier(catalogModel)) {
    return { reason: `${family} needs its own thinking switch` };
  }

  const levels = catalogModel.thinkingLevelMap;
  // Empty and all-null maps expose no selectable effort level.
  if (
    !isRecord(levels) ||
    Object.values(levels).every((value) => value === null)
  ) {
    return { reason: "catalog lists no effort levels" };
  }

  return { levels: levels as Record<string, string | null> };
}
