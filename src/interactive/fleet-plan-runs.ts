import { renderPricingSum } from "../core/telemetry/render.js";
import type { FleetRunOutcome, FleetRunStepEvent, FleetRunStepOutcome } from "../domains/dispatch/fleet-run.js";
import type { FleetRunPreview } from "../domains/dispatch/fleet-run-preview.js";

export type FleetPlanStepState = "pending" | "running" | "passed" | "failed" | "replayed";

export interface FleetPlanStepView {
	stepId: string;
	kind: "agent" | "code";
	/** What the step runs: the command line of a code step, the agent of an agent step. */
	label: string;
	state: FleetPlanStepState;
	/** Observed facts of a settled step, such as `exit 1 · 107ms`. Absent until it settles. */
	detail?: string;
}

export interface FleetPlanRunView {
	rootId: string;
	name: string;
	startedAtMs: number;
	finishedAtMs: number | null;
	/** Unsettled is a durable root with no recorded end: its process may be gone or may still be running elsewhere. */
	state: "running" | "passed" | "failed" | "unsettled";
	steps: ReadonlyArray<FleetPlanStepView>;
	requiredStepCount: number;
	succeededStepCount: number;
	/** What the plan cost, or null when no step called a model and there was nothing to price. */
	costText: string | null;
	/** Why the run ended without its steps settling, such as a refused workspace lock. */
	failure?: string;
}

export interface FleetPlanRuns {
	start(rootId: string, preview: FleetRunPreview): void;
	stepDispatched(rootId: string, event: FleetRunStepEvent): void;
	stepSettled(rootId: string, outcome: FleetRunStepOutcome): void;
	settle(rootId: string, outcome: FleetRunOutcome): FleetPlanRunView | null;
	fail(rootId: string, message: string): FleetPlanRunView | null;
	runs(): ReadonlyArray<FleetPlanRunView>;
	/** The plans this session has running now, read without touching the disk because a repaint asks. */
	live(): ReadonlyArray<FleetPlanRunView>;
}

function settledDetail(outcome: FleetRunStepOutcome): string | undefined {
	const record = outcome.codeStep;
	if (record !== undefined) {
		const exit = record.timedOut ? "timed out" : `exit ${record.exitCode}`;
		return `${exit} · ${record.durationMs < 1000 ? `${record.durationMs}ms` : `${(record.durationMs / 1000).toFixed(1)}s`}`;
	}
	return outcome.failureReason;
}

/**
 * The plans behind the Fleet Runs board. A code step makes no worker run, so the
 * telemetry behind the board never hears of it and the board said `No fleet runs
 * yet` right after a plan ran. A plan's own callbacks are the witnesses while it
 * runs here; the durable root records answer for every plan before this process.
 */
export function createFleetPlanRuns(
	now: () => number = Date.now,
	readDurable: () => ReadonlyArray<FleetPlanRunView> = () => [],
): FleetPlanRuns {
	const plans = new Map<string, FleetPlanRunView>();
	let hydrated = false;
	const update = (rootId: string, change: (plan: FleetPlanRunView) => FleetPlanRunView): FleetPlanRunView | null => {
		const plan = plans.get(rootId);
		if (plan === undefined) return null;
		const next = change(plan);
		plans.set(rootId, next);
		return next;
	};
	const updateStep = (rootId: string, stepId: string, change: (step: FleetPlanStepView) => FleetPlanStepView): void => {
		update(rootId, (plan) => ({
			...plan,
			steps: plan.steps.map((step) => (step.stepId === stepId ? change(step) : step)),
		}));
	};
	return {
		start(rootId, preview) {
			const steps = preview.waves.flatMap((wave) =>
				wave.steps.map(
					(step): FleetPlanStepView => ({
						stepId: step.stepId,
						kind: step.kind === "agent" ? "agent" : "code",
						label: step.kind === "agent" ? (step.agentId ?? "agent") : (step.argv?.join(" ") ?? step.commandId ?? "command"),
						state: "pending",
					}),
				),
			);
			plans.set(rootId, {
				rootId,
				name: preview.name,
				startedAtMs: now(),
				finishedAtMs: null,
				state: "running",
				steps,
				requiredStepCount: steps.length,
				succeededStepCount: 0,
				costText: null,
			});
		},
		stepDispatched(rootId, event) {
			updateStep(rootId, event.stepId, (step) => ({ ...step, state: event.replayed ? "replayed" : "running" }));
		},
		stepSettled(rootId, outcome) {
			const detail = settledDetail(outcome);
			updateStep(rootId, outcome.stepId, (step) => ({
				...step,
				state: outcome.replayed ? "replayed" : outcome.succeeded ? "passed" : "failed",
				...(detail !== undefined ? { detail } : {}),
			}));
		},
		settle(rootId, outcome) {
			return update(rootId, (plan) => ({
				...plan,
				finishedAtMs: now(),
				state: outcome.cleanRun ? "passed" : "failed",
				requiredStepCount: outcome.requiredStepCount,
				succeededStepCount: outcome.succeededStepCount,
				costText: plan.steps.some((step) => step.kind === "agent") ? renderPricingSum(outcome.totalCost) : null,
			}));
		},
		fail(rootId, message) {
			return update(rootId, (plan) => ({ ...plan, finishedAtMs: now(), state: "failed", failure: message }));
		},
		runs() {
			// Read once, on first use: the record of a plan this session starts comes
			// from its callbacks, which always outrank what the disk said earlier.
			if (!hydrated) {
				hydrated = true;
				for (const plan of readDurable()) if (!plans.has(plan.rootId)) plans.set(plan.rootId, plan);
			}
			return [...plans.values()];
		},
		live() {
			return [...plans.values()].filter((plan) => plan.state === "running");
		},
	};
}
