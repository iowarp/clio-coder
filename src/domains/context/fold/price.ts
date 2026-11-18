import type { AgentMessage } from "../../../engine/types.js";
import { createTokenEstimator } from "../../session/compaction/tokens.js";
import type { MessageEntry, SessionEntry } from "../../session/entries.js";

/**
 * The fold's price basis (ContextFold §4). A unit's price in one rendering is
 * what the token estimator returns for it: the provider-measured delta for an
 * isolated tool result, keyed to the entry and its converted content, else
 * the structural estimate. A marker is priced structurally. This book only
 * names which of the two a figure is; it never changes one.
 */

/** Whether a price is a provider-measured delta or the structural estimate. */
export type FoldPriceBasis = "measured" | "structural";

/** One ledger unit's price in the rendering the book was built for. */
export interface FoldUnitPrice {
	tokens: number;
	basis: FoldPriceBasis;
}

export interface FoldPriceBook {
	/** The unit's price and its basis. */
	price(entry: SessionEntry): FoldUnitPrice;
	/** The unit's tokens alone, the figure a planner sums. */
	tokens(entry: SessionEntry): number;
}

/**
 * Price the units of one rendering. `entries` is the rendered ledger slice the
 * measured deltas are read from, and `toReplayMessage` the converter the
 * request is built with, so a price matches what the provider is sent.
 */
export function createFoldPriceBook(
	entries: ReadonlyArray<SessionEntry>,
	toReplayMessage?: (entry: MessageEntry) => AgentMessage | null,
): FoldPriceBook {
	const estimator = createTokenEstimator(entries, toReplayMessage);
	return {
		price: (entry) => ({
			tokens: estimator.estimateEntry(entry),
			basis: estimator.isMeasured?.(entry) === true ? "measured" : "structural",
		}),
		tokens: (entry) => estimator.estimateEntry(entry),
	};
}
