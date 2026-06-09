/**
 * Holistic context-window accounting.
 *
 * `context-accounting.ts` answers "how full is the window" with a coarse four
 * way split that the footer bar consumes. This module answers the richer
 * question the `/context` overlay asks: where does every occupied token live?
 * It folds the compiled prompt segment manifest, the active tool schemas, the
 * conversation, and the autocompact reserve into a single categorized ledger
 * whose content groups always sum to one authoritative `usedTokens` figure.
 *
 * The total respects two floors so the breakdown never lies to the user:
 *  - the decomposed estimate (sum of every category we can name), and
 *  - the live anchored total (provider-measured usage when one exists).
 * When the measured total exceeds the decomposition, the delta is attributed
 * to Messages — the only category that grows turn over turn — mirroring the
 * proportional reconciliation the footer bar already performs.
 */

/** Distinct buckets a context window is divided into for display. */
export type ContextLedgerCategory =
	| "system"
	| "tools"
	| "agents"
	| "skills"
	| "memory"
	| "project"
	| "messages"
	| "pending"
	| "reserve"
	| "free";

/** A compiled-prompt segment with its estimated token cost. */
export interface ContextLedgerSegment {
	id: string;
	tokenEstimate: number;
}

export interface BuildContextLedgerInput {
	provider: string | null;
	model: string | null;
	/** Reported model context window in tokens; 0 or null when unknown. */
	contextWindow: number | null;
	/**
	 * Per-segment token estimates from the prompt compiler's segment manifest.
	 * When empty, `systemPromptTokens` is used as a single opaque system bucket.
	 */
	promptSegments?: ReadonlyArray<ContextLedgerSegment>;
	/** Fallback opaque system-prompt estimate when no segment manifest exists. */
	systemPromptTokens?: number;
	/** Serialized active tool-schema token estimate (the JSON the provider sees). */
	toolSchemaTokens?: number;
	/** Number of active tool schemas this turn. */
	toolCount?: number;
	/** Conversation message token estimate. */
	messageTokens?: number;
	/** Tokens for text the user has typed but not yet submitted. */
	pendingTokens?: number;
	/**
	 * Authoritative live total, already anchored to the latest provider usage
	 * when one is available. Acts as the measured floor for `usedTokens`.
	 */
	liveTotalTokens?: number | null;
	/** True when `liveTotalTokens` is anchored to real provider-reported usage. */
	measured?: boolean;
	/** Compaction trigger ratio (0..1); null when compaction is unconfigured. */
	compactionThreshold?: number | null;
	/** Whether automatic compaction is enabled. */
	compactionAuto?: boolean;
}

export interface ContextLedgerGroup {
	category: ContextLedgerCategory;
	label: string;
	tokens: number;
	/** Share of the context window (0..100); null when the window is unknown. */
	percent: number | null;
}

export interface ContextLedger {
	provider: string | null;
	model: string | null;
	/** Context window in tokens; 0 when unknown. */
	contextWindow: number;
	/** Sum of every content category (system..pending). */
	usedTokens: number;
	/** Autocompact headroom held in reserve above the conversation. */
	reserveTokens: number;
	/** Window left after used + reserve; 0 when the window is unknown. */
	freeTokens: number;
	/** used/window as a percentage; null when the window is unknown. */
	percent: number | null;
	/** True when `usedTokens` is anchored to provider-measured usage. */
	measured: boolean;
	compactionThreshold: number | null;
	compactionAuto: boolean;
	toolCount: number;
	/** Non-empty content categories in display order (excludes reserve/free). */
	groups: ReadonlyArray<ContextLedgerGroup>;
	/** Every category including reserve and free, for the proportional meter. */
	meter: ReadonlyArray<ContextLedgerGroup>;
}

const DEFAULT_AUTO_THRESHOLD = 0.85;

/** Maps a prompt segment id to the ledger bucket it belongs to. */
const SEGMENT_CATEGORY: Readonly<Record<string, ContextLedgerCategory>> = {
	identity: "system",
	"operating-contract": "system",
	safety: "system",
	runtime: "system",
	"tool-contract": "system",
	"retrieval-hints": "system",
	"tool-catalog": "tools",
	"tools-and-agents": "agents",
	"agent-fleet-deltas": "agents",
	"skills-catalog": "skills",
	memory: "memory",
	"project-context": "project",
	"history-summary": "messages",
};

/** Human labels for each bucket, shown verbatim in the overlay legend. */
export const CONTEXT_CATEGORY_LABEL: Readonly<Record<ContextLedgerCategory, string>> = {
	system: "System prompt",
	tools: "Tool definitions",
	agents: "Agent fleet",
	skills: "Skills",
	memory: "Memory",
	project: "Project context",
	messages: "Messages",
	pending: "Pending input",
	reserve: "Autocompact reserve",
	free: "Free space",
};

/** Display order for the content categories and the meter. */
const CONTENT_ORDER: ReadonlyArray<ContextLedgerCategory> = [
	"system",
	"tools",
	"agents",
	"skills",
	"memory",
	"project",
	"messages",
	"pending",
];

function categoryForSegment(id: string): ContextLedgerCategory {
	return SEGMENT_CATEGORY[id] ?? "system";
}

function finiteNonNegative(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function percentOf(tokens: number, window: number): number | null {
	if (window <= 0) return null;
	return Math.min(100, (tokens / window) * 100);
}

/**
 * Fold all context sources into a categorized ledger. Pure and synchronous so
 * it can be unit-tested and called on every overlay open without side effects.
 */
export function buildContextLedger(input: BuildContextLedgerInput): ContextLedger {
	const window = finiteNonNegative(input.contextWindow);

	const raw: Record<ContextLedgerCategory, number> = {
		system: 0,
		tools: 0,
		agents: 0,
		skills: 0,
		memory: 0,
		project: 0,
		messages: 0,
		pending: 0,
		reserve: 0,
		free: 0,
	};

	const segments = input.promptSegments ?? [];
	if (segments.length > 0) {
		for (const segment of segments) {
			raw[categoryForSegment(segment.id)] += finiteNonNegative(segment.tokenEstimate);
		}
	} else {
		raw.system += finiteNonNegative(input.systemPromptTokens);
	}
	raw.tools += finiteNonNegative(input.toolSchemaTokens);
	raw.messages += finiteNonNegative(input.messageTokens);
	raw.pending += finiteNonNegative(input.pendingTokens);

	const decomposed = CONTENT_ORDER.reduce((sum, category) => sum + raw[category], 0);
	const liveTotal = finiteNonNegative(input.liveTotalTokens);

	// Reconcile against the measured floor: attribute any excess the provider
	// counted beyond our decomposition to the conversation, the one category
	// that grows each turn.
	if (liveTotal > decomposed) {
		raw.messages += liveTotal - decomposed;
	}
	const usedTokens = Math.max(decomposed, liveTotal);

	const effectiveThreshold =
		typeof input.compactionThreshold === "number" && input.compactionThreshold > 0 && input.compactionThreshold < 1
			? input.compactionThreshold
			: input.compactionAuto
				? DEFAULT_AUTO_THRESHOLD
				: null;

	let reserveTokens = 0;
	let freeTokens = 0;
	if (window > 0) {
		const remaining = Math.max(0, window - usedTokens);
		reserveTokens = effectiveThreshold !== null ? Math.min(Math.round(window * (1 - effectiveThreshold)), remaining) : 0;
		freeTokens = Math.max(0, window - usedTokens - reserveTokens);
	}

	const groups: ContextLedgerGroup[] = [];
	for (const category of CONTENT_ORDER) {
		const tokens = raw[category];
		if (tokens <= 0) continue;
		groups.push({
			category,
			label: CONTEXT_CATEGORY_LABEL[category],
			tokens,
			percent: percentOf(tokens, window),
		});
	}

	const meter: ContextLedgerGroup[] = [...groups];
	if (reserveTokens > 0) {
		meter.push({
			category: "reserve",
			label: CONTEXT_CATEGORY_LABEL.reserve,
			tokens: reserveTokens,
			percent: percentOf(reserveTokens, window),
		});
	}
	if (window > 0) {
		meter.push({
			category: "free",
			label: CONTEXT_CATEGORY_LABEL.free,
			tokens: freeTokens,
			percent: percentOf(freeTokens, window),
		});
	}

	return {
		provider: input.provider ?? null,
		model: input.model ?? null,
		contextWindow: window,
		usedTokens,
		reserveTokens,
		freeTokens,
		percent: percentOf(usedTokens, window),
		measured: input.measured === true && liveTotal > 0,
		compactionThreshold: effectiveThreshold,
		compactionAuto: input.compactionAuto === true,
		toolCount: Math.max(0, Math.floor(input.toolCount ?? 0)),
		groups,
		meter,
	};
}
