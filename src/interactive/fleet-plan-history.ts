import { sumRunSpend } from "../core/telemetry/pricing.js";
import { renderPricingSum } from "../core/telemetry/render.js";
import { readFleetEventJournal } from "../domains/dispatch/fleet-event-journal.js";
import { dispatchOwnership } from "../domains/dispatch/ownership.js";
import { type FleetRunRecord, listFleetRuns, openLedger } from "../domains/dispatch/state.js";
import type { FleetPlanRunView, FleetPlanStepView } from "./fleet-plan-runs.js";

/** Plans a restarted board shows. The record directory holds every root the machine ever ran. */
const DURABLE_PLAN_LIMIT = 12;

type RecordedStep = FleetRunRecord["steps"][number]["result"];

function textField(step: Record<string, unknown>, field: string): string | null {
	const value = step[field];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function plannedStepOf(entry: unknown): { id: string; kind: "agent" | "code"; label: string } | null {
	if (typeof entry !== "object" || entry === null) return null;
	const step = entry as Record<string, unknown>;
	const id = textField(step, "id");
	if (id === null) return null;
	const argv = Array.isArray(step.argv) ? step.argv.filter((part) => typeof part === "string").join(" ") : "";
	const kind = step.kind === "code" ? "code" : "agent";
	const label =
		kind === "code"
			? argv || (textField(step, "commandId") ?? "command")
			: (textField(step, "agentId") ?? textField(step, "agent") ?? textField(step, "kind") ?? "agent");
	return { id, kind, label };
}

/** The sealed code step's exit code, which is all its record keeps of the settled facts a live plan folds. */
function recordedDetail(result: RecordedStep): string | undefined {
	if (result.failureReason !== undefined) return result.failureReason;
	try {
		const output = JSON.parse(result.output ?? "") as { exitCode?: unknown };
		return typeof output.exitCode === "number" ? `exit ${output.exitCode}` : undefined;
	} catch {
		return undefined;
	}
}

function recordedCost(record: FleetRunRecord, steps: ReadonlyArray<FleetPlanStepView>): string | null {
	if (!steps.some((step) => step.kind === "agent")) return null;
	const ledger = openLedger();
	const runs = record.steps.flatMap((entry) => {
		const run = typeof entry.result.terminalRunId === "string" ? ledger.get(entry.result.terminalRunId) : null;
		return run === null ? [] : [run];
	});
	return runs.length === 0 ? null : renderPricingSum(sumRunSpend(runs));
}

/**
 * One durable root as the board's plan row. The journal's seal is the verdict
 * the run itself reached, so it outranks a guess from the step results. A root
 * with neither a seal nor an end stamp reads as unsettled rather than running:
 * its process may be gone, and nothing here can see that.
 */
function fleetPlanFromRecord(record: FleetRunRecord): FleetPlanRunView {
	const results = new Map(record.steps.map((entry) => [entry.stepId, entry.result]));
	const steps = (record.planSteps ?? []).flatMap((entry): FleetPlanStepView[] => {
		const planned = plannedStepOf(entry);
		if (planned === null) return [];
		const result = results.get(planned.id);
		const detail = result === undefined ? undefined : recordedDetail(result);
		return [
			{
				stepId: planned.id,
				kind: planned.kind,
				label: planned.label,
				state: result === undefined ? "pending" : result.succeeded ? "passed" : "failed",
				...(detail !== undefined ? { detail } : {}),
			},
		];
	});
	let journal: ReturnType<typeof readFleetEventJournal> = null;
	try {
		journal = readFleetEventJournal(record.id);
	} catch {
		// An unreadable journal costs the seal, not the row.
	}
	const lastLine = journal?.lines.at(-1);
	const seal = journal?.broken === null && lastLine?.type === "fleet_sealed" ? lastLine : null;
	const succeededStepCount = steps.filter((step) => step.state === "passed").length;
	const ended = seal !== null || record.endedAt !== null;
	const passed = seal !== null ? seal.outcome === "succeeded" : succeededStepCount === steps.length;
	const lastAt = Date.parse(record.endedAt ?? lastLine?.at ?? record.startedAt);
	return {
		rootId: record.id,
		name: record.fleet,
		startedAtMs: Date.parse(record.startedAt),
		finishedAtMs: Number.isFinite(lastAt) ? lastAt : Date.parse(record.startedAt),
		state: !ended ? "unsettled" : passed ? "passed" : "failed",
		steps,
		requiredStepCount: steps.length,
		succeededStepCount,
		costText: recordedCost(record, steps),
		...(seal?.outcome === "aborted" ? { failure: "cancelled" } : {}),
		...(!ended ? { failure: "no end recorded" } : {}),
	};
}

/** This project's newest fleet roots. A malformed record costs its own row, never the board. */
export function readDurableFleetPlans(cwd: string, worktreeRoot?: string): FleetPlanRunView[] {
	const ownership = dispatchOwnership({ sessionId: null, cwd, ...(worktreeRoot !== undefined ? { worktreeRoot } : {}) });
	const plans: FleetPlanRunView[] = [];
	for (const record of listFleetRuns()) {
		if (plans.length >= DURABLE_PLAN_LIMIT) break;
		// Old roots recorded no cwd, so nothing places them in this project.
		if (record.cwd === undefined || !ownership.inProject(record.cwd)) continue;
		try {
			plans.push(fleetPlanFromRecord(record));
		} catch {
			// Written by another build; the listing goes on without it.
		}
	}
	return plans;
}
