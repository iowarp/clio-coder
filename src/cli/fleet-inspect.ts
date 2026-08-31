/**
 * Fixed machine-readable projection of recent durable dispatch runs.
 *
 * `fleet view` is an operator-directed terminal surface: it accepts a run id,
 * prints native evidence paths, and can follow one alternate-screen view. The
 * GUI cannot safely reuse that transport. This command accepts no identifier
 * or path, selects a bounded newest-first window itself, and emits only the
 * already-sanitized view model fields a typed host adapter can further narrow.
 */

import { listFleetRuns, openLedger } from "../domains/dispatch/state.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth } from "../engine/tui-primitives.js";
import { loadFleetRunViewModel, loadRunViewModel } from "./fleet-view.js";

export const FLEET_INSPECT_MAX_RUNS = 8;
export const FLEET_INSPECT_MAX_EVENTS = 32;
export const FLEET_INSPECT_MAX_ROOTS = 4;
export const FLEET_INSPECT_MAX_STEPS = 24;

const IDENTITY_WIDTH = 128;
const TASK_WIDTH = 400;
const EVENT_LABEL_WIDTH = 96;
const EVENT_DETAIL_WIDTH = 240;
const OUTCOME_WIDTH = 160;
const STEP_ID_WIDTH = 96;

export type FleetInspectEvidenceState = "pending" | "verified" | "failed" | "unavailable";

export interface FleetInspectEvent {
	readonly at: string;
	readonly label: string;
	readonly detail: string | null;
}

export interface FleetInspectRun {
	readonly runId: string;
	readonly agentId: string;
	readonly model: string;
	readonly target: string;
	readonly node: string;
	readonly phase: string;
	readonly startedAt: string;
	readonly elapsedMs: number;
	readonly task: string | null;
	readonly journal: "available" | "missing";
	readonly events: readonly FleetInspectEvent[];
	readonly eventsTruncated: boolean;
	readonly evidence: Readonly<{
		state: FleetInspectEvidenceState;
		summary: string;
	}>;
	readonly outcome: string | null;
	readonly outcomeDetail: string | null;
	readonly terminal: boolean;
}

export interface FleetInspectRootStep {
	readonly stepId: string;
	/** The run the step terminated on, or null when the step never ran. */
	readonly runId: string | null;
	readonly agentId: string | null;
	readonly outcome: string;
	readonly detail: string | null;
}

/**
 * One fleet root's step index.
 *
 * A root is not a run: it has no ledger row, receipt, or journal, so nothing
 * here is a transcript. What it answers is the question the run window alone
 * cannot, which is which planned steps a fleet had and which run each one
 * terminated on. That turns the flat recent-run list into something an operator
 * can trace back to the fleet that dispatched it.
 */
export interface FleetInspectRoot {
	readonly rootId: string;
	readonly fleet: string;
	readonly startedAt: string;
	readonly elapsedMs: number;
	readonly running: boolean;
	readonly resumedFrom: string | null;
	readonly plannedSteps: number;
	readonly recordedSteps: number;
	readonly steps: readonly FleetInspectRootStep[];
	readonly stepsTruncated: boolean;
}

export interface FleetInspectSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly runs: readonly FleetInspectRun[];
	readonly truncated: boolean;
	readonly roots: readonly FleetInspectRoot[];
	readonly rootsTruncated: boolean;
}

function bounded(value: string, width: number): string {
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return "unavailable";
	return sanitizeCallTargetText(truncateToWidth(sanitized, width, "…", false));
}

function evidenceProjection(text: string): FleetInspectRun["evidence"] {
	if (text.startsWith("receipt pending;")) {
		return {
			state: "pending",
			summary: "Receipt pending; this run has not finalized.",
		};
	}
	if (text.startsWith("RECEIPT INTEGRITY FAILED:")) {
		return {
			state: "failed",
			summary: "Clio Coder rejected the stored receipt's integrity.",
		};
	}
	if (text.startsWith("receipt unavailable:")) {
		return {
			state: "unavailable",
			summary: "The durable receipt is unavailable.",
		};
	}
	if (text.startsWith("trust v")) {
		return { state: "verified", summary: bounded(text, EVENT_DETAIL_WIDTH) };
	}
	return {
		state: "unavailable",
		summary: "Receipt trust could not be classified.",
	};
}

/** Pure command payload builder, exported so the fixed CLI contract is testable without subprocess output capture. */
export function fleetInspectSnapshot(now: () => number = Date.now): FleetInspectSnapshot {
	const ledgerRows = openLedger().list();
	const selected = ledgerRows.slice(0, FLEET_INSPECT_MAX_RUNS);
	const runs: FleetInspectRun[] = [];
	for (const row of selected) {
		const model = loadRunViewModel(row.id, { now });
		if (model === null) continue;
		const visibleEvents = model.transcript.slice(-FLEET_INSPECT_MAX_EVENTS);
		runs.push({
			runId: bounded(model.runId, IDENTITY_WIDTH),
			agentId: bounded(model.agentId, IDENTITY_WIDTH),
			model: bounded(model.model, IDENTITY_WIDTH),
			target: bounded(model.target, IDENTITY_WIDTH),
			node: bounded(model.node, IDENTITY_WIDTH),
			phase: bounded(model.phase, IDENTITY_WIDTH),
			startedAt: model.startedAt,
			elapsedMs: model.elapsedMs,
			task: model.task === undefined ? null : bounded(model.task, TASK_WIDTH),
			journal: model.journalPresent ? "available" : "missing",
			events: visibleEvents.map((event) => ({
				at: event.at,
				label: bounded(event.label, EVENT_LABEL_WIDTH),
				detail: event.detail === undefined ? null : bounded(event.detail, EVENT_DETAIL_WIDTH),
			})),
			eventsTruncated: model.transcriptTruncated || model.transcript.length > visibleEvents.length,
			evidence: evidenceProjection(model.evidence),
			outcome: model.outcome === null ? null : bounded(model.outcome, OUTCOME_WIDTH),
			outcomeDetail: model.outcomeDetail === null ? null : bounded(model.outcomeDetail, OUTCOME_WIDTH),
			terminal: model.terminal,
		});
	}
	const rootRecords = listFleetRuns();
	const selectedRoots = rootRecords.slice(0, FLEET_INSPECT_MAX_ROOTS);
	const roots: FleetInspectRoot[] = [];
	for (const record of selectedRoots) {
		const model = loadFleetRunViewModel(record.id, { now });
		if (model === null) continue;
		// The planned order is the order the operator wrote the fleet in, so the
		// index keeps its head rather than its tail: an operator reading a step
		// index is looking for where the fleet got to, not where it ended.
		const visibleSteps = model.steps.slice(0, FLEET_INSPECT_MAX_STEPS);
		roots.push({
			rootId: bounded(model.rootId, IDENTITY_WIDTH),
			fleet: bounded(model.fleet, IDENTITY_WIDTH),
			startedAt: model.startedAt,
			elapsedMs: model.elapsedMs,
			running: model.running,
			resumedFrom: model.resumedFrom === null ? null : bounded(model.resumedFrom, IDENTITY_WIDTH),
			plannedSteps: model.plannedSteps,
			recordedSteps: model.recordedSteps,
			steps: visibleSteps.map((step) => ({
				stepId: bounded(step.stepId, STEP_ID_WIDTH),
				runId: step.runId === null ? null : bounded(step.runId, IDENTITY_WIDTH),
				agentId: step.agentId === null ? null : bounded(step.agentId, IDENTITY_WIDTH),
				outcome: bounded(step.outcome, OUTCOME_WIDTH),
				detail: step.detail === undefined ? null : bounded(step.detail, OUTCOME_WIDTH),
			})),
			stepsTruncated: model.steps.length > visibleSteps.length,
		});
	}
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		runs,
		truncated: ledgerRows.length > selected.length || runs.length !== selected.length,
		roots,
		rootsTruncated: rootRecords.length > selectedRoots.length || roots.length !== selectedRoots.length,
	};
}

export function runFleetInspect(args: ReadonlyArray<string>): number {
	if (args.length !== 1 || args[0] !== "--json") {
		process.stderr.write("clio-coder fleet inspect: usage: clio-coder fleet inspect --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(fleetInspectSnapshot(), null, 2)}\n`);
	return 0;
}
