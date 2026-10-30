// A read-model quantity reaches the browser as { fact, display, ref } (#434 §11.2). The display is the canonical
// renderer's wording and the only text a surface shows for it; nothing here formats, rounds or sums a number.

export interface QuantityLike {
	readonly display: string;
}

/** What a surface says where a run row would be, when the run has no journal to read: a state, not a number. */
export const NOT_JOURNALED = "not journaled";

export function quantityText(quantity: QuantityLike | null | undefined): string {
	return quantity?.display ?? NOT_JOURNALED;
}

/**
 * A count the server sent as a bare integer: the v1 usage read and the usage report, which predate the read model
 * and retire with it (P5). It is grouped for reading and never summed, suffixed or inferred; an absent count says
 * so instead of reading as zero (L1).
 */
export function countText(value: number | null | undefined): string {
	return value == null || !Number.isFinite(value) ? "not recorded" : Math.round(value).toLocaleString("en-US");
}
