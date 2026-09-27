/**
 * The rungs a structural policy is composed of.
 *
 * A rung answers one question about what the session has finished with (was
 * the file rewritten, did a later read cover the same lines, was the failure
 * resolved, has the listing been walked) and emits the units that answer
 * yes. It never decides protection, never claims a unit twice, and never
 * prices anything itself: the composer (`compose.ts`) owns the emitter,
 * which runs every protection predicate, refuses duplicates and units that
 * are already out, and keeps the running headroom. A rung is therefore pure
 * over its input and the emitter's answers, and the same rung selects the
 * same units live and in replay.
 *
 * Each rung carries the `EvictionReason` it emits as its id, so a policy is
 * spelled as a reason list and the per-reason replay table reads back as the
 * rung list. Rung order is the policy: a unit that qualifies under two rungs
 * leaves for the first reason and carries the ref that explains it. The one
 * pressure-aware rung is `age_horizon`, which stops the moment the projection
 * reaches `target`; `recalled_twice` is a protection switch rather than a
 * selection and is handled by the composer.
 *
 * Deterministic by construction: the index is a pure function of the
 * entries, every loop runs in index order, and nothing here reads a clock,
 * a size ranking, or a recency score.
 */

import type { EvictionReason, SessionEntry } from "../../../session/entries.js";
import type { PolicyInput } from "../contract.js";
import { covers, type PathIndex, type PathObservation } from "../path-index.js";
import { hasThinking, isRecord, offloadPathOf, toolResultPayload, toolResultText } from "../payload.js";
import { findLaterRun, findLaterSuccess } from "../protect.js";

/** Every rung id is the reason it emits; `recalled_twice` is the churn pin the composer applies. */
export type RungId = Exclude<EvictionReason, "operator"> | "recalled_twice";

export interface RungInput {
	input: PolicyInput;
	index: PathIndex;
	/** First entry of the protected recent window. */
	cutoffIndex: number;
	/** Newest first: the unit closest to the horizon leaves first, so the cold region after the event stays small. */
	newestFirst: ReadonlyArray<PathObservation>;
	/** How the age rung orders its candidates; a profile may ask for bash output to go first. */
	ageOrder: "ledger" | "bash_first";
}

export interface RungEmitter {
	/**
	 * Claim a unit. False when it is protected, already out, unknown, claimed, or
	 * would free nothing. A rung that judged one observation passes it, so the
	 * composer can tell which member of a chain aggregate earned the reason; a
	 * rung that judged the whole entry passes its turnId.
	 */
	(unit: string | PathObservation, reason: EvictionReason, by?: string): boolean;
	/** Projected working-set tokens after everything emitted so far. */
	projected(): number;
}

export interface Rung {
	readonly id: RungId;
	run(rung: RungInput, emit: RungEmitter): void;
}

/** Ops that observe content rather than change it. */
const READ_CLASS = new Set<PathObservation["op"]>(["read", "grep", "find", "ls", "code_nav"]);
const MUTATING = new Set<PathObservation["op"]>(["write", "edit"]);
/**
 * Ops whose output is superseded by re-running the identical call. `read` is
 * left to `superseded_read`, which supersedes by line coverage rather than by
 * arguments; a mutation re-run is a different edit, not a fresher copy.
 */
const RERUNNABLE = new Set<PathObservation["op"]>(["bash", "grep", "find", "ls", "code_nav"]);
/** Search ops whose result is a list of places to look. */
const SEARCH_OPS = new Set<PathObservation["op"]>(["grep", "find", "bash"]);
/** Tools whose result is a worker receipt or a collection of one. */
const RECEIPT_TOOLS = new Set(["dispatch", "monitor"]);

/**
 * The mutation that invalidated this observation: the first successful one
 * after it. A failed edit (`oldText not found`, permission denied) changed
 * nothing, and the read it was aimed at is exactly what the model needs to fix
 * the edit.
 */
function firstMutationAfter(observation: PathObservation, index: PathIndex): PathObservation | null {
	for (const other of index.byPath.get(observation.path) ?? []) {
		if (other.entryIndex > observation.entryIndex && MUTATING.has(other.op) && !other.isError) return other;
	}
	return null;
}

/** The most recent later read of the same file that covers this one's lines. */
function lastCoveringRead(observation: PathObservation, index: PathIndex): PathObservation | null {
	let found: PathObservation | null = null;
	for (const other of index.byPath.get(observation.path) ?? []) {
		if (other.entryIndex <= observation.entryIndex || other.op !== "read" || other.isError) continue;
		if (covers(other.range, observation.range)) found = other;
	}
	return found;
}

/** Every surfaced path went on to be read. A path nobody read is an unread path. */
function isListingConsumed(observation: PathObservation, index: PathIndex): boolean {
	if (observation.surfaced.length === 0) return false;
	for (const path of observation.surfaced) {
		const readLater = (index.byPath.get(path) ?? []).some(
			(other) => other.op === "read" && !other.isError && other.entryIndex > observation.entryIndex,
		);
		if (!readLater) return false;
	}
	return true;
}

/**
 * Every surfaced path was read or changed afterwards. The generalization of
 * a consumed listing to match-line results: a grep whose hits were all edited
 * has done its job even when no read followed.
 */
function isSearchNarrowed(observation: PathObservation, index: PathIndex): boolean {
	if (!SEARCH_OPS.has(observation.op) || observation.surfaced.length === 0) return false;
	for (const path of observation.surfaced) {
		const usedLater = (index.byPath.get(path) ?? []).some(
			(other) =>
				!other.isError && other.entryIndex > observation.entryIndex && (other.op === "read" || MUTATING.has(other.op)),
		);
		if (!usedLater) return false;
	}
	return true;
}

/**
 * The edit echo is redundant once a later whole-file read shows the file as
 * it now stands, or a later successful mutation changed the same file again.
 * An edit carries no line range, so only a full read is taken to cover it.
 */
function diffAppliedBy(observation: PathObservation, index: PathIndex): PathObservation | null {
	if (!MUTATING.has(observation.op) || observation.toolCallId === null || observation.path.length === 0) return null;
	for (const other of index.byPath.get(observation.path) ?? []) {
		if (other.entryIndex <= observation.entryIndex || other.isError) continue;
		if (other.op === "read" && covers(other.range, null)) return other;
		if (MUTATING.has(other.op)) return other;
	}
	return null;
}

/** Run, assignment and batch identifiers a dispatch or monitor result carries in its details. */
function receiptIds(payload: unknown): string[] {
	const { result } = toolResultPayload(payload);
	const details = isRecord(result) && isRecord(result.details) ? result.details : null;
	if (details === null) return [];
	const ids: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && value.length > 0) ids.push(value);
	};
	push(details.batchId);
	for (const key of ["assignmentIds", "terminalRunIds"]) {
		const list = details[key];
		if (Array.isArray(list)) for (const value of list) push(value);
	}
	if (Array.isArray(details.runs)) {
		for (const run of details.runs) if (isRecord(run)) push(run.runId);
	}
	return ids;
}

function isReceiptResult(entry: SessionEntry): boolean {
	if (entry.kind !== "message" || entry.role !== "tool_result") return false;
	return RECEIPT_TOOLS.has(toolResultPayload(entry.payload).toolName);
}

/**
 * A receipt is settled once a later continuity commit folded it into the
 * durable note, or a later dispatch or monitor result carried the same run,
 * assignment or batch ids: the newer collection is the live receipt and the
 * older text is a claim about a run the session has since re-observed.
 */
function receiptSettledBy(entryIndex: number, entries: ReadonlyArray<SessionEntry>): string | null {
	const entry = entries[entryIndex];
	if (entry === undefined || entry.kind !== "message") return null;
	const ids = receiptIds(entry.payload);
	for (let i = entryIndex + 1; i < entries.length; i += 1) {
		const later = entries[i];
		if (later === undefined) continue;
		if (later.kind === "continuityCommit") return later.turnId;
		if (ids.length === 0 || later.kind !== "message" || !isReceiptResult(later)) continue;
		const { result } = toolResultPayload(later.payload);
		const laterIds = new Set(receiptIds(later.payload));
		const text = toolResultText(result);
		if (ids.some((id) => laterIds.has(id) || text.includes(id))) return later.turnId;
	}
	return null;
}

export const staleAfterMutationRung: Rung = {
	id: "stale_after_mutation",
	run({ index, newestFirst }, emit): void {
		// The file changed under it. Whatever the body said is now a claim about
		// a file that no longer exists in that form.
		for (const observation of newestFirst) {
			if (!READ_CLASS.has(observation.op) || observation.path.length === 0) continue;
			const mutation = firstMutationAfter(observation, index);
			if (mutation !== null) emit(observation, "stale_after_mutation", mutation.ref.entry);
		}
	},
};

export const supersededReadRung: Rung = {
	id: "superseded_read",
	run({ index, newestFirst }, emit): void {
		// The agent asked for the same lines again. It already decided this
		// content was worth re-fetching, and the newer copy is the live one.
		for (const observation of newestFirst) {
			if (observation.op !== "read" || observation.path.length === 0) continue;
			const superseding = lastCoveringRead(observation, index);
			if (superseding !== null) emit(observation, "superseded_read", superseding.ref.entry);
		}
	},
};

export const failureResolvedRung: Rung = {
	id: "failure_resolved",
	run({ index, newestFirst }, emit): void {
		// The marker keeps its first line, because a failure that happened is
		// evidence even once it is fixed.
		for (const observation of newestFirst) {
			if (!observation.isError) continue;
			const success = findLaterSuccess(observation, index);
			if (success !== null) emit(observation, "failure_resolved", success.ref.entry);
		}
	},
};

export const supersededCallRung: Rung = {
	id: "superseded_call",
	run({ index, newestFirst }, emit): void {
		// Test, build and lint loops re-run one command many times and every
		// older output is the fattest stale thing in the ledger; the newest run
		// is the one the model acts on.
		for (const observation of newestFirst) {
			if (!RERUNNABLE.has(observation.op)) continue;
			const rerun = findLaterRun(observation, index);
			if (rerun !== null) emit(observation, "superseded_call", rerun.ref.entry);
		}
	},
};

export const listingConsumedRung: Rung = {
	id: "listing_consumed",
	run({ index, newestFirst }, emit): void {
		// One surfaced path still unread and it stays: that is the path the
		// agent comes back to.
		for (const observation of newestFirst) {
			if (isListingConsumed(observation, index)) emit(observation, "listing_consumed");
		}
	},
};

export const searchNarrowedRung: Rung = {
	id: "search_narrowed",
	run({ index, newestFirst }, emit): void {
		for (const observation of newestFirst) {
			if (isSearchNarrowed(observation, index)) emit(observation, "search_narrowed");
		}
	},
};

export const diffAppliedRung: Rung = {
	id: "diff_applied",
	run({ index, newestFirst }, emit): void {
		for (const observation of newestFirst) {
			const by = diffAppliedBy(observation, index);
			if (by !== null) emit(observation, "diff_applied", by.ref.entry);
		}
	},
};

export const offloadedBodyRung: Rung = {
	id: "offloaded_body",
	run({ input, cutoffIndex }, emit): void {
		// The full body already lives at the offload path and the marker keeps
		// the pointer, so the in-context excerpt is redundant once its step
		// closes; the cutoff is what says the step closed.
		for (let i = cutoffIndex - 1; i >= 0; i -= 1) {
			const entry = input.entries[i];
			if (entry?.kind !== "message" || entry.role !== "tool_result") continue;
			if (offloadPathOf(toolResultPayload(entry.payload)) !== undefined) emit(entry.turnId, "offloaded_body");
		}
	},
};

export const dispatchReceiptSettledRung: Rung = {
	id: "dispatch_receipt_settled",
	run({ input, cutoffIndex }, emit): void {
		for (let i = cutoffIndex - 1; i >= 0; i -= 1) {
			const entry = input.entries[i];
			if (entry === undefined || !isReceiptResult(entry)) continue;
			const by = receiptSettledBy(i, input.entries);
			if (by !== null) emit(entry.turnId, "dispatch_receipt_settled", by);
		}
	},
};

export const thinkingTurnClosedRung: Rung = {
	id: "thinking_turn_closed",
	run({ input, cutoffIndex }, emit): void {
		// Reasoning from a closed step, the same rule age-horizon applies.
		for (let i = cutoffIndex - 1; i >= 0; i -= 1) {
			const entry = input.entries[i];
			if (entry?.kind !== "message" || entry.role !== "assistant") continue;
			if (hasThinking(entry.payload)) emit(entry.turnId, "thinking_turn_closed");
		}
	},
};

function isBashResult(entry: SessionEntry, index: PathIndex): boolean {
	return index.byRef.get(entry.turnId)?.op === "bash";
}

export const ageHorizonRung: Rung = {
	id: "age_horizon",
	run({ input, index, cutoffIndex, ageOrder }, emit): void {
		// Age, and only under pressure. Everything above is redundancy the
		// session can lose for free; this rung loses content that is still
		// good, so it runs only when the projection is still over threshold
		// and stops the moment it reaches target.
		const { pressure } = input;
		const window = pressure.contextWindow;
		if (window <= 0) return;
		if (emit.projected() <= pressure.threshold * window) return;
		const targetTokens = pressure.target * window;
		const passes: Array<(entry: SessionEntry) => boolean> =
			ageOrder === "bash_first"
				? [(entry) => isBashResult(entry, index), (entry) => !isBashResult(entry, index)]
				: [() => true];
		for (const admit of passes) {
			for (let i = cutoffIndex - 1; i >= 0 && emit.projected() > targetTokens; i -= 1) {
				const entry = input.entries[i];
				if (entry?.kind !== "message" || entry.role !== "tool_result" || !admit(entry)) continue;
				emit(entry.turnId, "age_horizon");
			}
		}
	},
};

/** `recalled_twice` is a protection the composer applies; it selects nothing itself. */
export const recalledTwiceRung: Rung = {
	id: "recalled_twice",
	run(): void {},
};

export const RUNGS: ReadonlyMap<RungId, Rung> = new Map<RungId, Rung>(
	[
		staleAfterMutationRung,
		supersededReadRung,
		failureResolvedRung,
		supersededCallRung,
		listingConsumedRung,
		searchNarrowedRung,
		diffAppliedRung,
		offloadedBodyRung,
		dispatchReceiptSettledRung,
		thinkingTurnClosedRung,
		ageHorizonRung,
		recalledTwiceRung,
	].map((rung) => [rung.id, rung]),
);

export function isRungId(value: string): value is RungId {
	return RUNGS.has(value as RungId);
}
