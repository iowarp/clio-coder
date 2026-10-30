import type { ContextLedger, WireContextLedger } from "../../contracts/context-ledger.js";
import { renderCompactCount, renderCount, renderFact } from "../clio/http-shims.js";

/**
 * The context ledger with every count worded by the canonical renderer (#434 §11.3). The ledger's used total is
 * provider-anchored or an estimate, and says which; the categories, reserve and compaction figures are its own
 * counts. Nothing here sums: each display words one number the agent reported.
 */
export function withLedgerDisplay(ledger: WireContextLedger): ContextLedger {
	const known = ledger.contextWindow > 0;
	const used = ledger.measured
		? ({ kind: "measured", value: ledger.usedTokens, source: "provider" } as const)
		: ({ kind: "estimated", value: ledger.usedTokens, method: "chars/4" } as const);
	const window = { kind: "measured", value: ledger.contextWindow, source: "provider" } as const;
	const share = (value: number | null) =>
		value === null ? null : renderFact({ kind: "measured", value, source: "local-count" }, "percent");
	const count = (value: number | null) => (value === null ? null : renderCount(value));
	const cache = ledger.promptCache;
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
