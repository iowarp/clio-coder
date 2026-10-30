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
