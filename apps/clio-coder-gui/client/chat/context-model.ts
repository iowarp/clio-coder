// What the context window view says, before any of it is drawn. Every number is Clio Coder's own
// accounting; this module only words it, and says "not reported" where the ledger has no value
// rather than printing a zero for it.

import type { ContextLedger } from "../../contracts/context-ledger.js";
import type { SessionWorkspace } from "../../contracts/session-telemetry.js";

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
	project: ContextFact[];
	/** The lead figure: the share when the window is known, and the counts it is a share of. */
	figure: { percent: string | null; used: string; window: string | null; basis: string };
	/** The window's settings and recent history as short label and value pairs, for a facts list. */
	facts: ContextFact[];
}

export interface ContextFact {
	label: string;
	/** An exact value, drawn in tabular figures; null when the fact is words only. */
	value: string | null;
	/** The words beside or instead of the value. */
	note: string | null;
}

const count = (value: number) => Math.round(value).toLocaleString("en-US");

export function contextWorkspaceFacts(workspace: SessionWorkspace): ContextFact[] {
	return [
		{ label: "Workspace", value: null, note: workspace.cwd },
		{
			label: "Repository",
			value: null,
			note: workspace.isGit ? (workspace.branch ?? "Detached HEAD") : "No Git repository",
		},
		...(workspace.isGit
			? [
					{
						label: "Working tree",
						value: null,
						note: workspace.dirty === null ? "Not reported" : workspace.dirty ? "Uncommitted changes" : "Clean",
					},
				]
			: []),
	];
}

function contextFacts(ledger: ContextLedger): ContextFact[] {
	const known = ledger.contextWindow > 0;
	const slots = ledger.contextWindowSlots;
	const route = [ledger.provider, ledger.model].filter(Boolean).join(" · ");
	const cache = ledger.promptCache;
	const facts: ContextFact[] = [
		{ label: "Model", value: null, note: route || "Route not reported" },
		known
			? {
					label: "Window",
					value: count(ledger.contextWindow),
					note: [
						SOURCE_WORDS[ledger.contextWindowSource ?? "unknown"] ?? ledger.contextWindowSource,
						slots ? `one of ${slots.slots} slots sharing ${count(slots.totalTokens)}` : null,
					]
						.filter(Boolean)
						.join(", "),
				}
			: { label: "Window", value: null, note: "Size not reported" },
		known
			? { label: "Free", value: count(ledger.freeTokens), note: null }
			: { label: "Free", value: null, note: "Not reported" },
		{ label: "Reserve", value: count(ledger.reserveTokens), note: "held for compaction" },
		{
			label: "Compaction",
			value:
				ledger.compactionAuto && ledger.compactionThreshold !== null
					? `${Math.round(ledger.compactionThreshold * 100)}%`
					: null,
			note: ledger.compactionAuto ? "automatic" : "Automatic compaction is off",
		},
	];
	if (ledger.lastCompaction !== null)
		facts.push({
			label: "Last compacted",
			value: `${count(ledger.lastCompaction.tokensBefore)} → ${count(ledger.lastCompaction.tokensAfter)}`,
			note: `runtime estimates; ${ledger.lastCompaction.trigger}`,
		});
	if (cache !== null)
		facts.push({
			label: "Prompt cache",
			value: cache.cacheReadTokens === null ? null : count(cache.cacheReadTokens),
			note: [
				cache.cacheReadTokens === null ? "cache reads not reported" : "read from the provider cache",
				cache.shellReused ? "session shell reused" : "session shell rebuilt",
				cache.backendVerdict === null ? null : VERDICT_WORDS[cache.backendVerdict],
			]
				.filter(Boolean)
				.join("; "),
		});
	return facts;
}

export function contextView(ledger: ContextLedger): ContextView {
	const known = ledger.contextWindow > 0;
	const slots = ledger.contextWindowSlots;
	return {
		project: [
			{ label: "Coverage", value: null, note: ledger.projectPreload ?? "Unavailable until a prompt has compiled" },
			{
				label: "Selected sources",
				value: null,
				note:
					ledger.projectHandbookFiles === null
						? "Not reported"
						: ledger.projectHandbookFiles.length === 0
							? "No project handbook selected"
							: ledger.projectHandbookFiles.join(", "),
			},
		],
		figure: {
			percent: known && ledger.percent !== null ? `${ledger.percent.toFixed(ledger.percent < 10 ? 1 : 0)}%` : null,
			used: count(ledger.usedTokens),
			window: known ? count(ledger.contextWindow) : null,
			basis: ledger.measured ? "Total anchored to provider-reported usage" : "Estimated until the provider reports usage",
		},
		facts: contextFacts(ledger),
		route: [ledger.provider, ledger.model].filter(Boolean).join(" · ") || "Route not reported",
		window: known
			? `${tokens(ledger.contextWindow)}${slots ? `, one of ${slots.slots} slots sharing ${tokens(slots.totalTokens)}` : ""}, ${
					SOURCE_WORDS[ledger.contextWindowSource ?? "unknown"] ?? ledger.contextWindowSource
				}.`
			: "Window size not reported, so no share of it can be shown.",
		accounting: `${tokens(ledger.usedTokens)} in use${share(ledger.percent)}, ${
			ledger.measured ? "anchored to provider-reported usage" : "estimated until the provider reports usage"
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
				: `Last compaction (${ledger.lastCompaction.trigger}): estimated ${tokens(ledger.lastCompaction.tokensBefore)} to ${tokens(ledger.lastCompaction.tokensAfter)}.`,
		cache:
			ledger.promptCache === null
				? null
				: [
						ledger.promptCache.shellReused ? "Session shell reused" : "Session shell rebuilt",
						ledger.promptCache.cacheReadTokens === null
							? "cache reads not reported"
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
