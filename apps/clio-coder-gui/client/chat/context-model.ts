// What the context window view says, before any of it is drawn. Every number is Clio Coder's own
// accounting; this module only words it, and says "not reported" where the ledger has no value
// rather than printing a zero for it.

import type { ContextLedger } from "../../contracts/context-ledger.js";

const SOURCE_WORDS: Readonly<Record<string, string>> = {
	loaded: "read from the loaded model",
	probe: "measured by a probe",
	catalog: "from the model catalog",
	"target-override": "set on this target",
	"model-hint": "from a model hint",
	"descriptor-default": "the runtime's default",
	unknown: "of unknown origin",
};

const VERDICT_WORDS: Readonly<Record<string, string>> = {
	hot: "the backend reused the prompt prefix",
	partial: "the backend reused part of the prompt prefix",
	cold: "the backend reprocessed the prompt prefix",
	small: "the prompt was too small for a cache verdict",
	unknown: "the backend did not report its cache",
};

const tokens = (value: number) => `${Math.round(value).toLocaleString("en-US")} tokens`;
const share = (value: number | null) => (value === null ? "" : ` (${value.toFixed(value < 10 ? 1 : 0)}%)`);

export interface ContextView {
	route: string;
	window: string;
	accounting: string;
	rows: Array<{ key: string; label: string; tokens: string; share: string }>;
	reserve: string;
	free: string;
	compaction: string;
	lastCompaction: string | null;
	cache: string | null;
	handbook: string | null;
}

export function contextView(ledger: ContextLedger): ContextView {
	const known = ledger.contextWindow > 0;
	const slots = ledger.contextWindowSlots;
	return {
		route: [ledger.provider, ledger.model].filter(Boolean).join(" · ") || "Route not reported",
		window: known
			? `${tokens(ledger.contextWindow)}${slots ? `, one of ${slots.slots} slots sharing ${tokens(slots.totalTokens)}` : ""}, ${
					SOURCE_WORDS[ledger.contextWindowSource ?? "unknown"] ?? ledger.contextWindowSource
				}.`
			: "Window size not reported, so no share of it can be shown.",
		accounting: `${tokens(ledger.usedTokens)} in use${share(ledger.percent)}, ${
			ledger.measured ? "measured by the provider" : "estimated until the provider reports usage"
		}.`,
		rows: ledger.groups.map((group) => ({
			key: group.category,
			label: group.label,
			tokens: Math.round(group.tokens).toLocaleString("en-US"),
			share: group.percent === null ? "" : `${group.percent.toFixed(group.percent < 10 ? 1 : 0)}%`,
		})),
		reserve: `${tokens(ledger.reserveTokens)} held in reserve for compaction.`,
		free: known ? `${tokens(ledger.freeTokens)} free.` : "Free space not reported.",
		compaction: ledger.compactionAuto
			? ledger.compactionThreshold === null
				? "Compacts automatically."
				: `Compacts automatically at ${Math.round(ledger.compactionThreshold * 100)}% of the window.`
			: "Automatic compaction is off.",
		lastCompaction:
			ledger.lastCompaction === null
				? null
				: `Last compaction (${ledger.lastCompaction.trigger}): ${tokens(ledger.lastCompaction.tokensBefore)} to ${tokens(ledger.lastCompaction.tokensAfter)}.`,
		cache:
			ledger.promptCache === null
				? null
				: [
						ledger.promptCache.shellReused ? "Session shell reused" : "Session shell rebuilt",
						ledger.promptCache.cacheReadTokens === null
							? "provider reported no cache reads"
							: `${tokens(ledger.promptCache.cacheReadTokens)} read from the provider cache`,
						ledger.promptCache.backendVerdict === null ? null : VERDICT_WORDS[ledger.promptCache.backendVerdict],
					]
						.filter(Boolean)
						.join("; ")
						.concat("."),
		handbook:
			ledger.projectHandbookFiles === null || ledger.projectHandbookFiles.length === 0
				? null
				: `Project handbook: ${ledger.projectHandbookFiles.join(", ")}.`,
	};
}
