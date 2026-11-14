import { CONTEXT_SEGMENTS, type ContextLedger, type WireContextLedger } from "../../contracts/context-ledger.js";
import { renderCompactCount, renderCount, renderFact } from "../clio/http-shims.js";

/**
 * The context ledger with every count worded by the canonical renderer (#434 §11.3). The ledger's used total is
 * provider-anchored or an estimate, and says which; the categories, reserve and compaction figures are its own
 * counts. Each display words one number the agent reported, except the window bar's folded part, which adds the
 * smallest categories' shares here so the browser neither rounds nor sums one. A category the agent gave no share
 * is not given one here: its part reads `not reported` and draws no width, and a folded part holding one does too.
 */
export function withLedgerDisplay(ledger: WireContextLedger): ContextLedger {
	const known = ledger.contextWindow > 0;
	const used = ledger.measured
		? ({ kind: "measured", value: ledger.usedTokens, source: "provider" } as const)
		: ({ kind: "estimated", value: ledger.usedTokens, method: "chars/4" } as const);
	const window = { kind: "measured", value: ledger.contextWindow, source: "provider" } as const;
	const percent = (value: number) => renderFact({ kind: "measured", value, source: "local-count" }, "percent");
	const share = (value: number | null) => (value === null ? null : percent(value));
	const count = (value: number | null) => (value === null ? null : renderCount(value));
	const cache = ledger.promptCache;
	// A category's part uses the share its table row words, so the legend and the table agree. Reported shares
	// lead, largest first, so the parts that fold are the smallest and the unreported.
	const parts: Array<{ key: string; label: string; fill: number | null }> = known
		? ledger.groups
				.filter((group) => group.tokens > 0)
				.map((group) => ({ key: group.category, label: group.label, fill: group.percent ?? null }))
				.sort((a, b) => (a.fill === null ? (b.fill === null ? 0 : 1) : b.fill === null ? -1 : b.fill - a.fill))
		: [];
	const folded = parts.slice(CONTEXT_SEGMENTS - 1);
	const segments =
		parts.length <= CONTEXT_SEGMENTS
			? parts
			: [
					...parts.slice(0, CONTEXT_SEGMENTS - 1),
					{
						key: "folded",
						label: "Other",
						fill: folded.every((part) => part.fill !== null) ? folded.reduce((sum, part) => sum + (part.fill ?? 0), 0) : null,
					},
				];
	return {
		...ledger,
		display: {
			used: renderCount(ledger.usedTokens),
			window: known ? renderCount(ledger.contextWindow) : null,
			free: known ? renderCount(ledger.freeTokens) : null,
			reserve: renderCount(ledger.reserveTokens),
			percent: known ? share(ledger.percent) : null,
			meter: known ? { used: renderCompactCount(used), window: renderCompactCount(window) } : null,
			slotsTotal: ledger.contextWindowSlots ? renderCount(ledger.contextWindowSlots.totalTokens) : null,
			groups: ledger.groups.map((group) => ({ tokens: renderCount(group.tokens), share: share(group.percent) })),
			// The contract's fill is a number, so an unreported share draws width 0 and says so in its words.
			segments: segments.map((part) => ({
				...part,
				fill: part.fill ?? 0,
				share: part.fill === null ? "not reported" : percent(part.fill),
			})),
			lastCompaction: ledger.lastCompaction
				? {
						before: renderCount(ledger.lastCompaction.tokensBefore),
						after: renderCount(ledger.lastCompaction.tokensAfter),
					}
				: null,
			cache: cache
				? {
						cacheRead: count(cache.cacheReadTokens),
						cacheWrite: count(cache.cacheWriteTokens),
						uncachedInput: count(cache.uncachedInputTokens),
					}
				: null,
		},
	};
}
