/** Provenance of the pricing data used to calculate a usage cost. */
export type CostProvenance = "known" | "known_free" | "estimated" | "unknown";

/** Absent provenance is never interpreted as free. */
export function normalizeCostProvenance(value: CostProvenance | undefined): CostProvenance {
	return value ?? "unknown";
}

const COST_PROVENANCE_VALUES: ReadonlySet<string> = new Set<CostProvenance>([
	"known",
	"known_free",
	"estimated",
	"unknown",
]);

/**
 * Validate an unvalidated wire value (a dispatch bus payload crossing a
 * worker process boundary, never runtime-checked against this closed set
 * before) against the four real provenance values. An unrecognized value
 * keeps `fallback` rather than being accepted as-is, matching how the
 * observability projection's run summary already treated this field; the
 * interactive dispatch board previously accepted any truthy string here.
 */
export function resolveCostProvenance(value: unknown, fallback: CostProvenance): CostProvenance {
	return typeof value === "string" && COST_PROVENANCE_VALUES.has(value) ? (value as CostProvenance) : fallback;
}
