/** Provenance of the pricing data used to calculate a usage cost. */
export type CostProvenance = "known" | "known_free" | "estimated" | "unknown";

/** Missing provenance on legacy records is never interpreted as free. */
export function normalizeCostProvenance(value: CostProvenance | undefined): CostProvenance {
	return value ?? "unknown";
}
