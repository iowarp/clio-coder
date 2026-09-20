// The fleet taxonomy. `SessionSnapshot.fleet` is an append-only list of facts, and rendering it as
// one row per fact with a JSON payload underneath is what the strip does today: five rows for one
// dispatched run, none of them saying what the run is doing.
//
// This folds the feed into one row per `runId` and gives every fact type a label, a tone and a
// sentence. Two rules carry the weight.
//
//  - `fleet.progress` is not a phase of its own. It is a running run that has reported activity,
//    kept distinct so the strip can show that a run is doing work rather than merely admitted.
//  - The supervisor logs and drops an event kind it does not recognise rather than killing the
//    session, so a fact type this build has never heard of must reduce to a readable row. Never a
//    crash, and never a silent drop.
//
// Every value shown is a reported fact. Nothing is derived, and nothing is shown for a run that was
// never reported. `taskPreview` is Clio's own sanitized 160-byte prefix, never the exact task.

import type { FleetItem } from "../../contracts/fleet-events.js";
import { formatDuration } from "../api/clock.js";
import type { StatusTone } from "../design/status.js";

/**
 * The feed as it may actually arrive. A newer engine can put a fact type on the wire that this
 * build's union does not name, so the reducer reads the envelope structurally and never assumes the
 * payload has the shape its type claims.
 */
export type FleetItemLike = Omit<FleetItem, "fact"> & {
	readonly fact: { readonly type: string; readonly payload?: unknown };
};

export type FleetRunState = "queued" | "running" | "progress" | "done" | "failed";

export interface FleetRun {
	readonly runId: string;
	readonly agentId: string;
	readonly state: FleetRunState;
	readonly taskPreview: string | null;
	readonly node: string | null;
	readonly attempt: number | null;
	readonly progressCount: number;
	readonly progressTruncated: boolean;
	readonly outcome: string | null;
	readonly durationMs: number | null;
	readonly tokenCount: number | null;
	readonly updatedAt: string;
}

export const FLEET_GLYPHS: Readonly<Record<FleetRunState, string>> = {
	queued: "…",
	running: "◐",
	progress: "◑",
	done: "✓",
	failed: "✕",
};

export const FLEET_STATE_LABELS: Readonly<Record<FleetRunState, string>> = {
	queued: "queued",
	running: "running",
	progress: "working",
	done: "done",
	failed: "failed",
};

export const FLEET_STATE_TONES: Readonly<Record<FleetRunState, StatusTone>> = {
	queued: "neutral",
	running: "running",
	progress: "running",
	done: "success",
	failed: "fail",
};

/** A run in one of these is still live; the rest have settled and must never disappear unannounced. */
const LIVE_STATES: ReadonlySet<FleetRunState> = new Set<FleetRunState>(["queued", "running", "progress"]);

export const isLiveRun = (run: FleetRun): boolean => LIVE_STATES.has(run.state);

/** The strip keeps this many runs, dropping the oldest settled one first. */
export const FLEET_RUN_CAP = 64;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const integer = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
const flag = (value: unknown): boolean => value === true;

const RUN_FACTS: ReadonlySet<string> = new Set([
	"fleet.enqueued",
	"fleet.started",
	"fleet.progress",
	"fleet.completed",
	"fleet.failed",
]);

/** True for the five fact types that fold into a run row. The other two belong to other surfaces. */
export const isRunFact = (type: string): boolean => RUN_FACTS.has(type);

function blank(runId: string, at: string): FleetRun {
	return {
		runId,
		agentId: "an unnamed agent",
		state: "queued",
		taskPreview: null,
		node: null,
		attempt: null,
		progressCount: 0,
		progressTruncated: false,
		outcome: null,
		durationMs: null,
		tokenCount: null,
		updatedAt: at,
	};
}

function apply(run: FleetRun, type: string, payload: Readonly<Record<string, unknown>>, at: string): FleetRun {
	const base = { ...run, agentId: text(payload.agentId) ?? run.agentId, updatedAt: at };
	switch (type) {
		case "fleet.enqueued":
		case "fleet.started":
			return {
				...base,
				state: type === "fleet.enqueued" ? "queued" : "running",
				taskPreview: text(payload.taskPreview) ?? base.taskPreview,
				node: text(payload.node) ?? base.node,
				attempt: integer(payload.attempt) ?? base.attempt,
			};
		case "fleet.progress":
			return {
				...base,
				state: "progress",
				progressCount: integer(payload.progressCount) ?? base.progressCount,
				progressTruncated: flag(payload.truncated),
			};
		case "fleet.completed":
			return {
				...base,
				state: "done",
				outcome: text(payload.outcome) ?? base.outcome,
				durationMs: integer(payload.durationMs) ?? base.durationMs,
				tokenCount: integer(payload.tokenCount) ?? base.tokenCount,
			};
		case "fleet.failed":
			return {
				...base,
				state: "failed",
				outcome: text(payload.outcome) ?? text(payload.reason) ?? base.outcome,
				durationMs: integer(payload.durationMs) ?? base.durationMs,
			};
		default:
			return base;
	}
}

/**
 * Fold the append-only feed into one row per run, in first-seen order so a row never jumps position
 * as it reports. The cap drops the oldest settled run first, because a settled row disappearing is
 * an acceptable loss and a live one disappearing is not.
 */
export function foldFleetRuns(items: readonly FleetItemLike[]): readonly FleetRun[] {
	const runs = new Map<string, FleetRun>();
	const ordered = [...items].sort((left, right) => left.sourceSequence - right.sourceSequence);
	for (const item of ordered) {
		if (!isRunFact(item.fact.type)) continue;
		const payload = record(item.fact.payload),
			runId = text(payload.runId);
		if (runId === null) continue;
		runs.set(runId, apply(runs.get(runId) ?? blank(runId, item.at), item.fact.type, payload, item.at));
	}
	if (runs.size <= FLEET_RUN_CAP) return [...runs.values()];
	const over = runs.size - FLEET_RUN_CAP;
	const settled = [...runs.values()].filter((run) => !isLiveRun(run)).slice(0, over);
	for (const run of settled) runs.delete(run.runId);
	while (runs.size > FLEET_RUN_CAP) {
		const oldest = runs.keys().next();
		if (oldest.done) break;
		runs.delete(oldest.value);
	}
	return [...runs.values()];
}

/** The state column: the state label, then `· `-separated reported fragments in a fixed order. */
export function fleetRunDetail(run: FleetRun): string {
	const parts = [FLEET_STATE_LABELS[run.state]];
	if (run.outcome !== null) parts.push(run.outcome);
	if (run.progressCount > 0) parts.push(`${run.progressCount}${run.progressTruncated ? "+" : ""} steps`);
	if (run.durationMs !== null) parts.push(formatDuration(run.durationMs));
	return parts.join(" · ");
}

export const fleetRunTitle = (run: FleetRun): string => run.taskPreview ?? "No task preview was reported.";
export const fleetRunNote = (run: FleetRun): string | null => (run.node === null ? null : `node ${run.node}`);

export const fleetSummaryLabel = (runs: readonly FleetRun[]): string =>
	`Fleet · ${runs.filter(isLiveRun).length} running of ${runs.length}`;

export const FLEET_SUMMARY_GLYPH = "⛭";

/** The filter's own `role="status"` line. A filter that hides rows has to say how many it hid. */
export function fleetFilterStatus(shown: number, total: number): string {
	const noun = total === 1 ? "run" : "runs";
	return shown === total ? `All ${total} reported ${noun} shown` : `${shown} of ${total} reported ${noun} shown`;
}

export const FLEET_EMPTY_FILTERED = "No run is running right now. Every reported run has settled.";
export const FLEET_EMPTY = "Clio Coder reports no dispatched runs in this conversation.";

// ---- the closed fact taxonomy ----------------------------------------------------------------

export interface FleetFactPresentation {
	readonly label: string;
	readonly tone: StatusTone;
	readonly summary: string;
	/** False for a type this build does not classify, which the strip prints as a plain row. */
	readonly known: boolean;
}

const amount = (value: number | null): string => (value === null ? "not reported" : value.toLocaleString("en-US"));

const DISPOSITION_LABELS: Readonly<Record<string, string>> = {
	block: "blocked the call",
	lockout: "locked the tool out for the rest of the turn",
	stop: "stopped the turn",
};

/**
 * Type to label, tone and one sentence, for every fact the wire names, plus a readable row for one
 * it does not. The two non-run facts are here so the strip can show them rather than drop them:
 * `evidence.ready` belongs to the evidence surface and `fleet.loopBlocked` to the activity group,
 * but neither surface is this one's problem and a fact that reaches here is still reported.
 */
export function presentFleetFact(fact: { readonly type: string; readonly payload?: unknown }): FleetFactPresentation {
	const payload = record(fact.payload);
	switch (fact.type) {
		case "fleet.enqueued":
			return {
				label: "Run queued",
				tone: "neutral",
				known: true,
				summary: `${text(payload.agentId) ?? "An unnamed agent"} was admitted${text(payload.node) === null ? "" : ` on node ${text(payload.node)}`}.`,
			};
		case "fleet.started":
			return {
				label: "Run started",
				tone: "running",
				known: true,
				summary: `${text(payload.agentId) ?? "An unnamed agent"} started work.`,
			};
		case "fleet.progress":
			return {
				label: "Run reporting",
				tone: "running",
				known: true,
				summary: `${amount(integer(payload.progressCount))} steps reported${flag(payload.truncated) ? ", and Clio Coder truncated the report" : ""}.`,
			};
		case "fleet.completed":
			return {
				label: "Run done",
				tone: "success",
				known: true,
				summary: `${text(payload.outcome) ?? "Finished"} after ${integer(payload.durationMs) === null ? "an unreported time" : formatDuration(integer(payload.durationMs) ?? 0)}, ${amount(integer(payload.tokenCount))} tokens.`,
			};
		case "fleet.failed":
			return {
				label: "Run failed",
				tone: "fail",
				known: true,
				summary: `${text(payload.outcome) ?? text(payload.reason) ?? "Clio Coder reported no reason"}.`,
			};
		case "fleet.loopBlocked": {
			const disposition = text(payload.disposition);
			return {
				label: "Loop guard",
				tone: flag(payload.interrupted) ? "fail" : "warn",
				known: true,
				summary: `${text(payload.tool) ?? "A tool"} repeated ${amount(integer(payload.repeatCount))} times against a budget of ${amount(integer(payload.budget))}, so Clio Coder ${disposition === null ? "intervened" : (DISPOSITION_LABELS[disposition] ?? disposition)}.`,
			};
		}
		case "evidence.ready":
			return {
				label: "Evidence ready",
				tone: flag(payload.firstPassSuccess) ? "success" : "warn",
				known: true,
				summary: `${amount(integer(payload.findingCount))} findings recorded${flag(payload.firstPassSuccess) ? " on the first pass" : ""}.`,
			};
		default:
			return {
				label: fact.type,
				tone: "neutral",
				known: false,
				summary: "Clio Coder reported a fact this build does not classify.",
			};
	}
}

export interface FleetNotice {
	readonly id: string;
	readonly at: string;
	readonly presentation: FleetFactPresentation;
}

/** The facts that are not runs, in reported order, so nothing in the feed is dropped in silence. */
export function fleetNotices(items: readonly FleetItemLike[]): readonly FleetNotice[] {
	return items
		.filter((item) => !isRunFact(item.fact.type))
		.map((item) => ({ id: item.id, at: item.at, presentation: presentFleetFact(item.fact) }));
}
