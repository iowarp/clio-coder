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

// Every count is the server's display (#434 §11.3); this model only places it in words.
const tokens = (display: string) => `${display} tokens`;
const share = (display: string | null) => (display === null ? "" : ` (${display})`);

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
	cacheFacts: ContextFact[];
}

export interface ContextFact {
	label: string;
	/** An exact value, drawn in tabular figures; null when the fact is words only. */
	value: string | null;
	/** The words beside or instead of the value. */
	note: string | null;
}

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
	const display = ledger.display;
	const known = display.window !== null;
	const slots = ledger.contextWindowSlots;
	const route = [ledger.provider, ledger.model].filter(Boolean).join(" · ");
	const facts: ContextFact[] = [
		{ label: "Model", value: null, note: route || "Route not reported" },
		known
			? {
					label: "Window",
					value: display.window,
					note: [
						SOURCE_WORDS[ledger.contextWindowSource ?? "unknown"] ?? ledger.contextWindowSource,
						slots ? `one of ${slots.slots} slots sharing ${display.slotsTotal}` : null,
					]
						.filter(Boolean)
						.join(", "),
				}
			: { label: "Window", value: null, note: "Size not reported" },
		known ? { label: "Free", value: display.free, note: null } : { label: "Free", value: null, note: "Not reported" },
		{ label: "Reserve", value: display.reserve, note: "held for compaction" },
		{
			label: "Compaction",
			value:
				ledger.compactionAuto && ledger.compactionThreshold !== null
					? `${Math.round(ledger.compactionThreshold * 100)}%`
					: null,
			note: ledger.compactionAuto ? "automatic" : "Automatic compaction is off",
		},
	];
	if (ledger.lastCompaction !== null && display.lastCompaction !== null)
		facts.push({
			label: "Last compacted",
			value: `${display.lastCompaction.before} → ${display.lastCompaction.after}`,
			note: `runtime estimates; ${ledger.lastCompaction.trigger}`,
		});
	return facts;
}

function promptCacheFacts(
	cache: ContextLedger["promptCache"],
	display: ContextLedger["display"]["cache"],
): ContextFact[] {
	if (cache === null || display === null) return [{ label: "Prompt cache", value: null, note: "Not reported" }];
	return [
		{
			label: "Session shell",
			value: null,
			note: cache.shellReused ? "Reused compiled shell" : "Rebuilt compiled shell",
		},
		{
			label: "Backend verdict",
			value: null,
			note: cache.backendVerdict === null ? "Not reported" : (VERDICT_WORDS[cache.backendVerdict] ?? "Not reported"),
		},
		...(
			[
				["Cache read", display.cacheRead],
				["Cache write", display.cacheWrite],
				["Uncached input", display.uncachedInput],
			] as const
		).map(([label, value]) => ({
			label,
			value,
			note: value === null ? "Not reported" : "tokens · last run",
		})),
	];
}

export function contextView(ledger: ContextLedger): ContextView {
	const display = ledger.display;
	const known = display.window !== null;
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
			percent: display.percent,
			used: display.used,
			window: display.window,
			basis: ledger.measured ? "Total anchored to provider-reported usage" : "Estimated until the provider reports usage",
		},
		facts: contextFacts(ledger),
		cacheFacts: promptCacheFacts(ledger.promptCache, display.cache),
		route: [ledger.provider, ledger.model].filter(Boolean).join(" · ") || "Route not reported",
		window: known
			? `${tokens(display.window ?? "")}${slots && display.slotsTotal ? `, one of ${slots.slots} slots sharing ${tokens(display.slotsTotal)}` : ""}, ${
					SOURCE_WORDS[ledger.contextWindowSource ?? "unknown"] ?? ledger.contextWindowSource
				}.`
			: "Window size not reported, so no share of it can be shown.",
		accounting: `${tokens(display.used)} in use${share(display.percent)}, ${
			ledger.measured ? "anchored to provider-reported usage" : "estimated until the provider reports usage"
		}.`,
		rows: ledger.groups.map((group, index) => ({
			key: group.category,
			label: group.label,
			tokens: display.groups[index]?.tokens ?? "not reported",
			share: display.groups[index]?.share ?? "",
		})),
		reserve: `${tokens(display.reserve)} held in reserve for compaction.`,
		free: display.free !== null ? `${tokens(display.free)} free.` : "Free space not reported.",
		compaction: ledger.compactionAuto
			? ledger.compactionThreshold === null
				? "Compacts automatically."
				: `Compacts automatically at ${Math.round(ledger.compactionThreshold * 100)}% of the window.`
			: "Automatic compaction is off.",
		lastCompaction:
			ledger.lastCompaction === null || display.lastCompaction === null
				? null
				: `Last compaction (${ledger.lastCompaction.trigger}): estimated ${tokens(display.lastCompaction.before)} to ${tokens(display.lastCompaction.after)}.`,
		cache:
			ledger.promptCache === null
				? null
				: [
						ledger.promptCache.shellReused ? "Session shell reused" : "Session shell rebuilt",
						display.cache?.cacheRead == null
							? "cache reads not reported"
							: `${tokens(display.cache.cacheRead)} read from the provider cache`,
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
