/**
 * The durable half of a worker block.
 *
 * A `/run`, a `/delegate`, or a model-driven dispatch draws its block from live
 * bus events, which a resumed session no longer has. What it does still have is
 * two things it wrote at the time: a `workerRun` session entry naming the run,
 * and the sealed receipt under `receipts/<runId>.json` holding the answer. This
 * module is the bridge in both directions. It projects a live entry state onto
 * the session entry going out, and rebuilds the same {@link WorkerEntryState}
 * from entries plus receipts coming back, so replay hands the renderer the
 * exact object the reducer would have.
 *
 * Streamed prose never crosses either way. The receipt is the terminal truth
 * for a worker's answer, so persisting the live tail would only add a second,
 * staler copy of it to the session file.
 *
 * Pure: the receipt reader is a parameter, so nothing here touches disk.
 */

import type { WorkerAction } from "../domains/observability/worker-progress.js";
import type { SessionEntryInput, WorkerRunEntry } from "../domains/session/index.js";
import {
	boundSettledText,
	type WorkerAttempt,
	type WorkerEntryState,
	type WorkerReceiptReader,
	workerReceiptSummary,
	workerTargetLabel,
} from "./worker-stream.js";

/** The `workerRun` entry a live block is worth, minus the fields the ledger stamps. */
export type WorkerRunEntryInput = Extract<SessionEntryInput, { kind: "workerRun" }>;

/** The same entry minus its parent pointer, which only the session owner can resolve. */
export type WorkerRunEntryFields = Omit<WorkerRunEntryInput, "parentTurnId">;

/**
 * The custom session entry that records what a settled run's live stream knew
 * and its receipt does not: the context its last model call occupied, and the
 * calls it finished last, which its Detailed card lists. Never rendered, never
 * model context; replay reads it back onto the block.
 */
export const WORKER_SETTLED_ENTRY = "workerSettled";

/** One finished call as a settled card's trail states it: the tool and the safety layer's descriptor. */
export interface WorkerSettledCall {
	tool: string;
	verb?: string;
	object?: string;
	truncated?: true;
}

export interface WorkerSettledFields {
	runId: string;
	/** The context the run's last model call occupied, when its stream reported one. */
	contextTokens?: number;
	/** The calls the run finished last, newest first, bounded as the live trail is. */
	calls?: WorkerSettledCall[];
}

function settledCall(action: WorkerAction): WorkerSettledCall {
	const descriptor = action.descriptor;
	return {
		tool: action.tool,
		...(descriptor !== undefined ? { verb: descriptor.verb } : {}),
		...(descriptor?.object !== undefined ? { object: descriptor.object } : {}),
		...(descriptor?.truncated === true ? { truncated: true as const } : {}),
	};
}

/** What a settled block records for replay; null when its stream reported neither context nor calls. */
export function workerSettledFields(state: WorkerEntryState): WorkerSettledFields | null {
	const reported = state.progress?.contextTokens;
	const contextTokens = reported !== undefined && Number.isFinite(reported) && reported > 0 ? reported : undefined;
	const calls = (state.progress?.recentActions ?? []).map(settledCall);
	if (contextTokens === undefined && calls.length === 0) return null;
	return {
		runId: state.runId,
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(calls.length > 0 ? { calls } : {}),
	};
}

function settledCallFromData(value: unknown): WorkerSettledCall[] {
	if (value === null || typeof value !== "object") return [];
	const { tool, verb, object, truncated } = value as Record<string, unknown>;
	if (typeof tool !== "string" || tool.length === 0) return [];
	return [
		{
			tool,
			...(typeof verb === "string" && verb.length > 0 ? { verb } : {}),
			...(typeof object === "string" && object.length > 0 ? { object } : {}),
			...(truncated === true ? { truncated: true as const } : {}),
		},
	];
}

/** A recorded settled-run fact, from a custom entry's data; null when it is not one. */
export function workerSettledFromData(data: unknown): WorkerSettledFields | null {
	if (data === null || typeof data !== "object") return null;
	const { runId, contextTokens, calls } = data as Record<string, unknown>;
	if (typeof runId !== "string") return null;
	const context = typeof contextTokens === "number" && Number.isFinite(contextTokens) ? contextTokens : undefined;
	const trail = Array.isArray(calls) ? calls.flatMap(settledCallFromData) : [];
	if (context === undefined && trail.length === 0) return null;
	return {
		runId,
		...(context !== undefined ? { contextTokens: context } : {}),
		...(trail.length > 0 ? { calls: trail } : {}),
	};
}

/** A recorded call as the trail action the card renders. */
function settledCallAction(call: WorkerSettledCall): WorkerAction {
	if (call.verb === undefined) return { tool: call.tool };
	return {
		tool: call.tool,
		descriptor: {
			verb: call.verb,
			...(call.object !== undefined ? { object: call.object } : {}),
			...(call.truncated === true ? { truncated: true } : {}),
		},
	};
}

/**
 * One attempt's durable identity, read off the live block at the moment it
 * starts. Called on every DispatchStarted for a transcript-bound run, so a
 * failover writes a second entry under the same assignment rather than
 * amending the first: the attempt trail is history, and history is
 * append-only. The scalars are copied here; the runtime object is shared, and
 * safely so, because the reducer replaces it on failover rather than mutating
 * it.
 */
export function workerRunEntryFields(state: WorkerEntryState): WorkerRunEntryFields {
	const { assignmentId, runId, origin, agentId, runtime, parentToolCallId } = state;
	return {
		kind: "workerRun",
		...(state.helper ? { helper: true as const } : {}),
		...(state.task !== undefined ? { task: state.task } : {}),
		assignmentId,
		runId,
		origin,
		agentId,
		runtime,
		...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
	};
}

/**
 * Rebuild one block per assignment from the entries that recorded it.
 *
 * Attempts fold the way they did live: the entries of one assignment become one
 * block whose header names the last attempt and whose rail carries an `↻` line
 * for each earlier one, so a resumed failover reads as the single run it was.
 * The body and footer come from the last attempt's receipt, which is the
 * attempt that actually produced an answer, through the same projection the
 * live fold uses to settle a block.
 *
 * The returned map is keyed by assignment. Tool names are not reconstructed:
 * they were live telemetry, the receipt seals a call count rather than a list,
 * and inventing names from anything else would put a worker's arguments one
 * inference away from the transcript.
 */
export function workerEntriesFromRunEntries(
	entries: ReadonlyArray<WorkerRunEntry>,
	readReceipt: WorkerReceiptReader,
	/** What each settled run's live stream knew, by run id, from `workerSettled` entries. */
	settledRuns: ReadonlyMap<string, WorkerSettledFields> = new Map(),
): Map<string, WorkerEntryState> {
	const byAssignment = new Map<string, WorkerRunEntry[]>();
	for (const entry of entries) {
		const attempts = byAssignment.get(entry.assignmentId);
		if (attempts === undefined) byAssignment.set(entry.assignmentId, [entry]);
		else attempts.push(entry);
	}

	const states = new Map<string, WorkerEntryState>();
	for (const [assignmentId, attempts] of byAssignment) {
		const last = attempts[attempts.length - 1];
		if (last === undefined) continue;
		const facts = readReceipt(last.runId);
		const bounded = boundSettledText(facts?.text ?? "");
		const settled = settledRuns.get(last.runId);
		const contextTokens = settled?.contextTokens;
		const trail: WorkerAttempt[] = attempts.map((attempt) => ({
			runId: attempt.runId,
			targetLabel: workerTargetLabel(attempt.runtime),
			...(attempt.runId === last.runId && facts !== null ? { outcome: facts.outcome } : {}),
		}));
		states.set(assignmentId, {
			assignmentId,
			runId: last.runId,
			origin: last.origin,
			...(last.helper ? { helper: true as const } : {}),
			...(last.task !== undefined ? { task: last.task } : {}),
			agentId: last.agentId,
			runtime: last.runtime,
			text: bounded.text,
			droppedLines: bounded.dropped,
			tools: [],
			attempts: trail,
			pending: false,
			receipt: workerReceiptSummary(facts),
			...(contextTokens !== undefined ? { contextTokens } : {}),
			...(settled?.calls !== undefined ? { recentActions: settled.calls.map(settledCallAction) } : {}),
			...(last.parentToolCallId !== undefined ? { parentToolCallId: last.parentToolCallId } : {}),
		});
	}
	return states;
}
