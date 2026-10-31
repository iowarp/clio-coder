// A read-model quantity reaches the browser as { fact, display, ref } (#434 §11.2). The display is the canonical
// renderer's wording and the only text a surface shows for it; nothing here formats, rounds or sums a number.

import type { ExplanationV1, Quantity } from "../../contracts/wire.js";

export interface QuantityLike {
	readonly display: string;
}

/** What a surface says where a run row would be, when the run has no journal to read: a state, not a number. */
export const NOT_JOURNALED = "not journaled";

export function quantityText(quantity: QuantityLike | null | undefined): string {
	return quantity?.display ?? NOT_JOURNALED;
}

/** A figure as a surface carries it: the server's words, and the reference explain() resolves when it has one. */
export interface Explainable {
	readonly value: string;
	readonly factRef: string | null;
}

/** A read-model quantity for a surface; an absent one reads `absent` and has nothing to explain. */
export function explainable(
	quantity: { readonly display: string; readonly ref?: string } | null | undefined,
	absent = NOT_JOURNALED,
): Explainable {
	return quantity ? { value: quantity.display, factRef: quantity.ref ?? null } : { value: absent, factRef: null };
}

export interface ExplanationView {
	readonly value: string;
	readonly coverage: string;
	readonly rule: string;
	/** Each kind of contributor the read model listed, with the ids it named. */
	readonly sources: readonly { readonly label: string; readonly ids: readonly string[] }[];
	/** Contributors beyond the server's cap, counted there and never listed. */
	readonly omitted: string | null;
}

/** What one quantity's explanation says (#434 §11.4): its value, coverage and fold rule in the server's words. */
export function explanationView(explanation: ExplanationV1): ExplanationView {
	const { from } = explanation;
	return {
		value: explanation.value.display,
		coverage: explanation.coverage,
		rule: explanation.rule,
		sources: [
			{ label: "Calls", ids: from.callIds },
			{ label: "Attempts", ids: from.attemptIds },
			{ label: "Runs", ids: from.runIds },
			{ label: "Records", ids: from.recordIds },
		].filter((source) => source.ids.length > 0),
		omitted: from.omitted > 0 ? `${from.omitted} more contributors are not listed.` : null,
	};
}

/**
 * A count the server sent as a bare integer: the v1 usage read and the usage report, which predate the read model
 * and retire with it (P5). It is grouped for reading and never summed, suffixed or inferred; an absent count says
 * so instead of reading as zero (L1).
 */
export function countText(value: number | null | undefined): string {
	return value == null || !Number.isFinite(value) ? "not recorded" : Math.round(value).toLocaleString("en-US");
}

export interface QuantityParts {
	measured: number;
	estimated: number;
	/** Contributions whose amount is unknown; above zero, the display reads as a lower bound. */
	unknown: number;
	/** Whether any contribution was measured or estimated at all. */
	known: boolean;
	/**
	 * The one amount a bar may scale by: the known part when it is all measured or all estimated, a lower bound while
	 * `unknown` is above zero; null when nothing is known or the kinds mix.
	 */
	amount: number | null;
	/** `amount` when no part is unknown: the only figure a share may divide by. */
	exact: number | null;
}

/** A quantity's fact read as its parts; a single fact reads as a sum of one, so no two facts are added here. */
export function quantityParts(quantity: { readonly fact: Quantity["fact"] }): QuantityParts {
	const fact = quantity.fact;
	const parts =
		"kind" in fact
			? {
					measured: fact.kind === "measured" ? fact.value : 0,
					estimated: fact.kind === "estimated" ? fact.value : 0,
					unknown: fact.kind === "unknown" ? 1 : 0,
					known: fact.kind === "measured" || fact.kind === "estimated",
				}
			: {
					measured: fact.measured,
					estimated: fact.estimated,
					unknown: fact.unknownCount,
					known: fact.coverage.measured > 0 || fact.coverage.estimated > 0,
				};
	const amount = !parts.known
		? null
		: parts.estimated === 0
			? parts.measured
			: parts.measured === 0
				? parts.estimated
				: null;
	return { ...parts, amount, exact: parts.unknown > 0 ? null : amount };
}
