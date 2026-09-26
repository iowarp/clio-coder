import type { WorkingSetSettings } from "../../../../core/defaults.js";
import { findCutPoint } from "../../../session/compaction/cut-point.js";
import { estimateTokens } from "../../../session/compaction/tokens.js";
import type {
	CompactionSummaryEntry,
	ContextEvictionEntry,
	EvictedItem,
	SessionEntry,
} from "../../../session/entries.js";
import { isPressureCheckpointBefore, withinRearmBand } from "../checkpoint.js";
import { EMPTY_WORKING_SET_VIEW, type PolicyInput, type WorkingSetPolicy, type WorkingSetView } from "../contract.js";
import { buildEvictionFields, planEviction } from "../engine.js";
import { foldWorkingSet } from "../fold.js";
import { isTurnStart } from "../horizon.js";
import { projectWorkingSet } from "../project.js";
import { selectVisibleEntries } from "../visible.js";
import type { ReplayCandidatePoolPolicy } from "./controls.js";
import type { Trace } from "./trace.js";

/**
 * The summary stage, modeled. Live, when the projection is still over the
 * threshold after an eviction, Clio summarizes: it cuts the history at
 * `findCutPoint(entries, keepRecentTokens)` and replaces everything before
 * the cut with one paraphrase. On iterative compaction, the cut search starts
 * strictly after the previous `compactionSummary`; the retained suffix that
 * replay still shows is canonical input to the new paraphrase, not new raw
 * history to price a second time. A long trace replayed without that stage
 * spends most of its length in a regime the product never enters, because
 * operator text, call arguments, and markers accumulate past any budget and
 * no policy can evict them. The model appends the same `compactionSummary`
 * record the live path would, with a constant-size summary standing in for the
 * paraphrase, and counts it, so a policy is judged by how rarely it forces the
 * one lossy, token-spending stage.
 */
export interface ReplaySummaryModel {
	/** Mirrors `compaction.keepRecentTokens`: the cut keeps at least this many recent tokens. */
	keepRecentTokens: number;
	/** Tokens the stand-in summary occupies. */
	summaryTokens: number;
}

export interface ReplayConfig {
	policyId: string;
	budgetTokens: number;
	threshold: number;
	target: number;
	settings: WorkingSetSettings;
	/** Absent: summaries are counted as `turnsToFirstSummary` but never applied. */
	summaries?: ReplaySummaryModel;
	/**
	 * The modeled request-fit limit as a share of the budget. Live, a request
	 * must fit input plus the output reserve inside the window, and a checkpoint
	 * that fails that check reduces regardless of the rearm band. The real
	 * reserve is an absolute token count (32,768 by default), which would swallow
	 * the whole of a 32k replay budget, so the fit is modeled as a fraction.
	 * Absent: 0.95.
	 */
	overflowFraction?: number;
}

const DEFAULT_OVERFLOW_FRACTION = 0.95;

export interface ReplayEvictionEvent {
	turnIndex: number;
	/** The pressure checkpoint the event fired at, in `checkpointPositions` coordinates. */
	checkpointIndex: number;
	items: ReadonlyArray<EvictedItem>;
	tokensBefore: number;
	tokensAfter: number;
	/** True when this event exhausted the policy's usable candidate pool. */
	saturated: boolean;
	/**
	 * Tokens of the projected working set from the earliest evicted position to
	 * the end, after the event: what an exact-prefix cache (Anthropic, OpenAI,
	 * vLLM) re-prefills on the next request because the bytes before it moved.
	 */
	coldPrefixTokens: number;
}

export interface ReplayTraceResult {
	traceId: string;
	policyId: string;
	budgetTokens: number;
	turnCount: number;
	/** Pressure checkpoints the trace offered: one per model request, as `isPressureCheckpointBefore` counts them. */
	checkpointCount: number;
	events: ReadonlyArray<ReplayEvictionEvent>;
	/** Tool-result refs only, keyed to the checkpoint that removed them; thinking-unit evictions are intentionally absent. */
	evictedAt: ReadonlyMap<string, number>;
	turnsToFirstSummary: number | null;
	/** Summary compactions applied under `config.summaries`. */
	summaries: number;
	/** Checkpoints where the projection exceeded `overflowFraction` and reduction was forced past the rearm band. */
	overflowReductions: number;
	/**
	 * Projected tokens after each applied summary, summed: a summary rewrites
	 * the prompt from its cut, so an exact-prefix cache re-prefills all of it.
	 * The summary side of the cache-miss bill, beside `coldPrefixTokens`.
	 */
	summaryColdPrefixTokens: number;
	/** Original entries plus synthetic append-only contextEviction and compactionSummary records. */
	entries: ReadonlyArray<SessionEntry>;
}

function sumTokens(entries: ReadonlyArray<SessionEntry>): number {
	let tokens = 0;
	for (const entry of entries) tokens += estimateTokens(entry);
	return tokens;
}

function hasCandidatePool(policy: WorkingSetPolicy): policy is ReplayCandidatePoolPolicy {
	return "replayCandidateCount" in policy && typeof policy.replayCandidateCount === "function";
}

function latestCompactionIndex(entries: ReadonlyArray<SessionEntry>): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.kind === "compactionSummary") return index;
	}
	return -1;
}

function eventSaturated(
	policy: WorkingSetPolicy,
	input: PolicyInput,
	plan: { items: ReadonlyArray<EvictedItem>; tokensAfter: number },
): boolean {
	if (policy.id === "age-horizon") return true;
	if (hasCandidatePool(policy)) return plan.items.length === policy.replayCandidateCount(input);
	const targetTokens = input.pressure.target * input.pressure.contextWindow;
	const thresholdTokens = input.pressure.threshold * input.pressure.contextWindow;
	const usedAgeRung = plan.items.some((item) => item.reason === "age_horizon");
	// A structural composition's unconditional rungs can legitimately stop
	// between target and threshold. Saturation means the age rung actually ran
	// and exhausted its pool before reaching target.
	return plan.tokensAfter > targetTokens && (plan.tokensAfter > thresholdTokens || usedAgeRung);
}

interface IncrementalProjection {
	raw: SessionEntry[];
	projected: SessionEntry[];
	indexByTurnId: Map<string, number>;
	tokens: number;
}

function rebuildProjection(
	soFar: ReadonlyArray<SessionEntry>,
	leaf: string | null,
	view: WorkingSetView,
): IncrementalProjection {
	const raw = selectVisibleEntries(soFar, leaf ?? undefined);
	const projected = projectWorkingSet(raw, view);
	return {
		raw,
		projected,
		indexByTurnId: new Map(raw.map((entry, index) => [entry.turnId, index])),
		tokens: sumTokens(projected),
	};
}

function projectAppendedEntry(entry: SessionEntry, state: IncrementalProjection, view: WorkingSetView): SessionEntry {
	if (view.evictionEvents === 0) return entry;
	const lastEventId = view.lastEvictionTurnId;
	if (lastEventId !== null && state.indexByTurnId.has(lastEventId)) {
		// The new entry follows the visible cutoff event, so it is unchanged.
		return entry;
	}
	// The latest event is behind a compaction cut. projectWorkingSet deliberately
	// treats an absent event as later than this slice, so new assistants inherit
	// the same usage-invalidation stamp as the rest of the visible slice.
	return projectWorkingSet([entry], view)[0] ?? entry;
}

function appendVisibleEntry(entry: SessionEntry, state: IncrementalProjection, view: WorkingSetView): void {
	const projected = projectAppendedEntry(entry, state, view);
	state.indexByTurnId.set(entry.turnId, state.raw.length);
	state.raw.push(entry);
	state.projected.push(projected);
	state.tokens += estimateTokens(projected);
}

function applyEvictionProjection(
	state: IncrementalProjection,
	synthetic: ContextEvictionEntry,
	view: WorkingSetView,
	items: ReadonlyArray<EvictedItem>,
): void {
	const affected = new Set<number>();
	for (const item of items) {
		const index = state.indexByTurnId.get(item.ref.entry);
		if (index !== undefined) affected.add(index);
	}
	// The new cutoff invalidates usage on every assistant before it. Scanning
	// assistants once per applied event is linear in events, never in turns.
	for (let index = 0; index < state.raw.length - 1; index += 1) {
		const entry = state.raw[index];
		if (entry?.kind === "message" && entry.role === "assistant") affected.add(index);
	}
	for (const index of affected) {
		const source = state.raw[index];
		const before = state.projected[index];
		if (source === undefined || before === undefined) continue;
		const after = projectWorkingSet([source, synthetic], view)[0] ?? source;
		state.projected[index] = after;
		state.tokens += estimateTokens(after) - estimateTokens(before);
	}
}

function coldPrefixTokens(state: IncrementalProjection, items: ReadonlyArray<EvictedItem>): number {
	let cut = state.projected.length;
	for (const item of items) {
		const index = state.indexByTurnId.get(item.ref.entry);
		if (index !== undefined && index < cut) cut = index;
	}
	let tokens = 0;
	for (let index = cut; index < state.projected.length; index += 1) {
		const entry = state.projected[index];
		if (entry !== undefined) tokens += estimateTokens(entry);
	}
	return tokens;
}

/**
 * Live plan/fold/project code driven at every pressure checkpoint the ledger
 * offers: the turn start and every tool-batch boundary, exactly where the chat
 * loop asks (`isPressureCheckpointBefore`). The rearm band gates a checkpoint
 * the same way `performAutoCompact` does, so the harness fires where the
 * product fires and stays quiet where the product stays quiet.
 */
export function replayTrace(trace: Trace, policy: WorkingSetPolicy, config: ReplayConfig): ReplayTraceResult {
	const soFar: SessionEntry[] = [];
	const events: ReplayEvictionEvent[] = [];
	const evictedAt = new Map<string, number>();
	const toolResults = new Set(
		trace.entries
			.filter((entry) => entry.kind === "message" && entry.role === "tool_result")
			.map((entry) => entry.turnId),
	);
	let evictionSequence = 0;
	let summaries = 0;
	let summaryColdPrefixTokens = 0;
	let overflowReductions = 0;
	let turnIndex = 0;
	let checkpointIndex = 0;
	let turnsToFirstSummary: number | null = null;
	let lastMessageTurnId: string | null = null;
	let view: WorkingSetView = EMPTY_WORKING_SET_VIEW;
	let visible: IncrementalProjection = { raw: [], projected: [], indexByTurnId: new Map(), tokens: 0 };
	const pressureLimit = config.threshold * config.budgetTokens;
	const overflowLimit = (config.overflowFraction ?? DEFAULT_OVERFLOW_FRACTION) * config.budgetTokens;

	for (let entryIndex = 0; entryIndex < trace.entries.length; entryIndex += 1) {
		const entry = trace.entries[entryIndex];
		if (entry === undefined) continue;
		if (isTurnStart(entry)) turnIndex += 1;
		if (isPressureCheckpointBefore(trace.entries, entryIndex)) {
			checkpointIndex += 1;
			const leaf = lastMessageTurnId;
			const tokens = visible.tokens;
			// The overflow path ignores the band, as the live fit check does.
			const overflow = tokens > overflowLimit;
			if (overflow) overflowReductions += 1;
			const attempt =
				overflow ||
				(tokens > pressureLimit &&
					!withinRearmBand({
						projectedTokens: tokens,
						contextWindow: config.budgetTokens,
						rearmFraction: config.settings.rearmFraction,
						lastEvictionTokensAfter: view.lastEvictionTokensAfter,
					}));
			if (attempt) {
				const input: PolicyInput = {
					entries: visible.raw,
					view,
					cwd: trace.cwd,
					settings: config.settings,
					pressure: {
						tokens,
						contextWindow: config.budgetTokens,
						threshold: config.threshold,
						target: config.target,
					},
					estimateTokens,
				};
				const plan = planEviction(policy, input);
				if (plan !== null) {
					const saturated = eventSaturated(policy, input, plan);
					evictionSequence += 1;
					const previous = soFar[soFar.length - 1];
					const synthetic: ContextEvictionEntry = {
						...buildEvictionFields(plan, {
							trigger: "pressure",
							pressureBefore: tokens / config.budgetTokens,
							snapshotIdBefore: null,
						}),
						turnId: `replay-evict-${evictionSequence}`,
						parentTurnId: leaf,
						timestamp: previous?.timestamp ?? entry.timestamp,
					};
					soFar.push(synthetic);
					appendVisibleEntry(synthetic, visible, view);
					view = foldWorkingSet(soFar, leaf ?? undefined);
					applyEvictionProjection(visible, synthetic, view, plan.items);
					events.push({
						turnIndex,
						checkpointIndex,
						items: plan.items,
						tokensBefore: plan.tokensBefore,
						tokensAfter: plan.tokensAfter,
						saturated,
						coldPrefixTokens: coldPrefixTokens(visible, plan.items),
					});
					for (const item of plan.items) {
						if (toolResults.has(item.ref.entry) && !evictedAt.has(item.ref.entry)) {
							evictedAt.set(item.ref.entry, checkpointIndex);
						}
					}
				}
				if (visible.tokens > pressureLimit) {
					if (turnsToFirstSummary === null) turnsToFirstSummary = turnIndex;
					const previousCompactionIndex = latestCompactionIndex(soFar);
					const boundaryStart = previousCompactionIndex + 1;
					const cut =
						config.summaries === undefined
							? boundaryStart
							: findCutPoint(soFar, config.summaries.keepRecentTokens, { startIndex: boundaryStart }).firstKeptEntryIndex;
					// A cut at the iterative boundary has no new history or turn prefix,
					// which is the live "nothing to compact" case.
					if (config.summaries !== undefined && cut > boundaryStart) {
						summaries += 1;
						const visibleBefore = new Set(visible.raw.map((candidate) => candidate.turnId));
						const previous = soFar[soFar.length - 1];
						const firstKeptTurnId = soFar[cut]?.turnId ?? "";
						const synthetic: CompactionSummaryEntry = {
							kind: "compactionSummary",
							turnId: `replay-summary-${summaries}`,
							parentTurnId: firstKeptTurnId || null,
							timestamp: previous?.timestamp ?? entry.timestamp,
							summary: "#".repeat(config.summaries.summaryTokens * 4),
							tokensBefore: visible.tokens,
							firstKeptTurnId,
						};
						soFar.push(synthetic);
						// The summary moved the baseline: the fold drops the band anchor.
						view = foldWorkingSet(soFar, leaf ?? undefined);
						visible = rebuildProjection(soFar, lastMessageTurnId, view);
						summaryColdPrefixTokens += visible.tokens;
						const visibleAfter = new Set(visible.raw.map((candidate) => candidate.turnId));
						for (const removed of visibleBefore) {
							if (toolResults.has(removed) && !visibleAfter.has(removed) && !evictedAt.has(removed)) {
								evictedAt.set(removed, checkpointIndex);
							}
						}
					}
				}
			}
		}
		soFar.push(entry);
		// Recorded recalls are observed demand, not a policy's eviction plan.
		// Fold them before the next selection; real summaries reset the band
		// just as the synthetic summary path above does.
		if (entry.kind === "contextRecall" || entry.kind === "compactionSummary") {
			view = foldWorkingSet(soFar, lastMessageTurnId ?? undefined);
		}
		if (entry.kind === "compactionSummary") visible = rebuildProjection(soFar, lastMessageTurnId, view);
		else appendVisibleEntry(entry, visible, view);
		if (entry.kind === "message") lastMessageTurnId = entry.turnId;
	}

	return {
		traceId: trace.id,
		policyId: config.policyId,
		budgetTokens: config.budgetTokens,
		turnCount: trace.turnCount,
		checkpointCount: checkpointIndex,
		events,
		evictedAt,
		turnsToFirstSummary,
		summaries,
		overflowReductions,
		summaryColdPrefixTokens,
		entries: soFar,
	};
}
