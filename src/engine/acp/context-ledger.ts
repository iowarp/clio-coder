import type { AcpContextLedger } from "./types.js";

export type { AcpContextLedger } from "./types.js";
export { ACP_CONTEXT_LEDGER_METHOD, ACP_CONTEXT_META_KEY } from "./types.js";

/**
 * `_clio-coder/context/ledger`: the terminal's `/context` window view as one
 * bounded projection of `chat.contextLedger()`.
 *
 * The ledger is Clio Coder's own accounting: which categories fill the window,
 * how much is held in reserve for compaction, whether the total is measured by
 * the provider or estimated, and what the prompt cache reused. This projection
 * reads it and nothing else, so a client shows the same numbers the terminal
 * does and cannot recompute them differently. Unknown stays unknown: a window
 * of 0 and a null percentage travel as they are.
 */

import type { ContextLedger } from "../../domains/session/context-ledger.js";

const MAX_GROUPS = 32;
const MAX_HANDBOOK_FILES = 16;
const MAX_TEXT_BYTES = 256;

function bounded(text: string): string {
	let safe = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		safe += code <= 0x1f || code === 0x7f ? " " : character;
	}
	if (Buffer.byteLength(safe, "utf8") <= MAX_TEXT_BYTES) return safe;
	let cut = safe.slice(0, MAX_TEXT_BYTES);
	while (Buffer.byteLength(cut, "utf8") > MAX_TEXT_BYTES - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}

const optional = (text: string | null | undefined) => (text === null || text === undefined ? null : bounded(text));
const count = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const nullableCount = (value: number | null | undefined) =>
	value === null || value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.round(value));

export function projectContextLedger(ledger: ContextLedger): AcpContextLedger {
	const slots = ledger.contextWindowSlots;
	const cache = ledger.promptCache;
	return {
		version: 1,
		provider: optional(ledger.provider),
		model: optional(ledger.model),
		contextWindow: count(ledger.contextWindow),
		contextWindowSource: optional(ledger.contextWindowSource),
		contextWindowSlots: slots === null ? null : { slots: count(slots.slots), totalTokens: count(slots.totalContextSize) },
		usedTokens: count(ledger.usedTokens),
		reserveTokens: count(ledger.reserveTokens),
		freeTokens: count(ledger.freeTokens),
		percent: ledger.percent === null || !Number.isFinite(ledger.percent) ? null : Math.max(0, ledger.percent),
		measured: ledger.measured,
		compactionThreshold:
			ledger.compactionThreshold === null || !Number.isFinite(ledger.compactionThreshold)
				? null
				: ledger.compactionThreshold,
		compactionAuto: ledger.compactionAuto,
		projectPreload: optional(ledger.projectPreload),
		projectHandbookFiles:
			ledger.projectHandbookFiles === null ? null : ledger.projectHandbookFiles.slice(0, MAX_HANDBOOK_FILES).map(bounded),
		toolCount: count(ledger.toolCount),
		groups: ledger.groups.slice(0, MAX_GROUPS).map((group) => ({
			category: group.category,
			label: bounded(group.label),
			tokens: count(group.tokens),
			percent: group.percent === null || !Number.isFinite(group.percent) ? null : Math.max(0, group.percent),
		})),
		lastCompaction:
			ledger.lastCompaction === null || ledger.lastCompaction === undefined
				? null
				: {
						stage: bounded(ledger.lastCompaction.stage),
						tokensBefore: count(ledger.lastCompaction.tokensBefore),
						tokensAfter: count(ledger.lastCompaction.tokensAfter),
						trigger: bounded(ledger.lastCompaction.trigger),
					},
		promptCache:
			cache === null
				? null
				: {
						shellReused: cache.shellReused,
						cacheReadTokens: nullableCount(cache.cacheReadTokens),
						cacheWriteTokens: nullableCount(cache.cacheWriteTokens),
						uncachedInputTokens: nullableCount(cache.uncachedInputTokens),
						backendVerdict: cache.backendVerdict,
					},
	};
}
