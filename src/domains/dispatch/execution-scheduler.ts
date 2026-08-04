import { type ExecutionHandoff, projectExecutionHandoffs } from "./execution-handoff.js";
import {
	type ExecutionPlan,
	type ExecutionPlanAgentStep,
	type ExecutionPlanCodeStep,
	type ExecutionPlanLoop,
	type ExecutionPlanStep,
	executionPlanAncestors,
} from "./execution-plan.js";

export interface ExecutionStepResult extends ExecutionHandoff {
	succeeded: boolean;
	integrityValid: boolean;
	/**
	 * The step changed the workspace outside its declared boundary. Sealed by
	 * the orchestrator after the fact, never by the step: a run that reports on
	 * its own writes is not a witness.
	 */
	boundaryViolated?: boolean;
}

/**
 * The verdict on one scheduling window's write boundary, projected for the
 * scheduler. The full record, with the offending paths and everything rolled
 * back, is written durably by whoever performs the check.
 */
export interface ExecutionWriteBoundaryOutcome {
	/** `wave-<n>` or `revalidate-<stepId>-<n>`; matches the durable record. */
	window: string;
	violated: boolean;
	/** Steps that fail because of it. More than one means concurrent authorship. */
	failedStepIds: ReadonlyArray<string>;
	/** Operator-facing message naming the paths and the declaration. */
	detail: string | null;
}
export interface ExecutionPlanAdmission {
	step: ExecutionPlanAgentStep;
	costUpperBoundUsd: number;
	nodeId: string;
}

/**
 * How a loop ended.
 *
 * `loop_bound_exhausted` is the declared bound spent without a passing
 * verification: every attempt ran and the answer was still no. It is a typed
 * outcome rather than a generic step failure because the operator's question
 * ("did it converge?") is different from "did something break", and because
 * the bound is the number they get to change.
 */
export type ExecutionLoopReason = "resolved" | "loop_bound_exhausted" | "loop_step_failed" | "loop_not_reached";

export interface ExecutionLoopOutcome {
	loopId: string;
	resolved: boolean;
	/** Verifications that actually ran, including staleness revalidations. */
	attempts: number;
	repairs: number;
	reason: ExecutionLoopReason;
}

/** One coordinator continuation decision for a loop whose check is an agent. */
export interface ExecutionLoopDecision {
	/** Whether the verification passed and the loop is done. */
	resolved: boolean;
	/** Structured findings threaded to the repair attempt, or null. */
	findings: string | null;
	/** Operator-facing reason the gate produced no usable verdict. */
	needsDecision?: string | null;
}

export interface ExecutionLoopDecisionInput {
	loop: ExecutionPlanLoop;
	step: ExecutionPlanStep;
	/** 1-based verification ordinal. */
	attempt: number;
	/** True when the declared bound leaves no further repair. */
	terminalAttempt: boolean;
	result: ExecutionStepResult;
	/** Results the loop has produced so far, by step id. */
	priorResults: ReadonlyMap<string, ExecutionStepResult>;
}

export interface ExecutionSchedulerAdapter {
	preflight(step: ExecutionPlanAgentStep): ExecutionPlanAdmission;
	reserve(plan: ExecutionPlan, admissions: ReadonlyArray<ExecutionPlanAdmission>): { ownerId: string };
	run(
		step: ExecutionPlanAgentStep,
		handoffs: ReadonlyArray<ExecutionHandoff>,
		reservation: { ownerId: string; memberId: string },
	): Promise<{ assignmentId: string; result: Promise<ExecutionStepResult> }>;
	/**
	 * Execute a deterministic step. It takes no reservation because it holds no
	 * worker capacity lease. Required only for plans that contain code steps.
	 * `priorResults` is what a commit node reads its message from: the message
	 * belongs to the agent that produced the work, not to the committer.
	 */
	runCode?(
		step: ExecutionPlanCodeStep,
		handoffs: ReadonlyArray<ExecutionHandoff>,
		signal: AbortSignal,
		priorResults: ReadonlyMap<string, ExecutionStepResult>,
	): Promise<ExecutionStepResult>;
	/**
	 * Decide whether an agent verification resolved its loop. Required only for
	 * plans with an agent-checked loop: a worker that merely ran successfully
	 * has not said whether the work passes, and the scheduler refuses to guess.
	 */
	decideLoop?(input: ExecutionLoopDecisionInput): Promise<ExecutionLoopDecision>;
	/**
	 * Record the workspace as it stands before a window's steps run. Required
	 * only for plans whose steps declare a boundary; a plan that declares one
	 * and a scheduler that cannot check it is refused rather than run
	 * unenforced.
	 */
	beginWriteBoundary?(window: string, stepIds: ReadonlyArray<string>): void;
	/**
	 * Compare the workspace against that snapshot, roll back what the window was
	 * not allowed to change, and return the verdict. Runs before any result
	 * crosses an edge: a step that wrote outside its boundary must not hand its
	 * output to a dependent as though it had passed.
	 */
	verifyWriteBoundary?(window: string, stepIds: ReadonlyArray<string>): Promise<ExecutionWriteBoundaryOutcome>;
	cancel(assignmentId: string): void;
	release(ownerId: string): void;
	releaseUnconsumed(ownerId: string): void;
}
export interface ExecutionPlanResult {
	planHash: string;
	results: ReadonlyMap<string, ExecutionStepResult>;
	skipped: ReadonlyArray<string>;
	/** Nodes a resolved loop made unnecessary; declared, never run, not failures. */
	unneeded: ReadonlyArray<string>;
	loops: ReadonlyArray<ExecutionLoopOutcome>;
	/** Verifications re-run because a later workspace step invalidated their green. */
	revalidated: ReadonlyArray<string>;
	needsDecision: ReadonlyArray<string>;
	/** Every enforced window, in scheduling order, violated or not. */
	writeBoundaries: ReadonlyArray<ExecutionWriteBoundaryOutcome>;
}

/**
 * Times one verification may be re-run for staleness inside a single plan. A
 * deterministic command is cheap, but an unbounded revalidation chain is a
 * loop nobody declared, so the plan fails closed instead.
 */
export const STALENESS_REVALIDATION_LIMIT = 3;

/**
 * A step whose completion can change what a verification measured. A
 * verification does not invalidate itself, and a commit records the tree
 * without editing it; everything else that may write does invalidate.
 */
function isWorkspaceMutator(step: ExecutionPlanStep): boolean {
	if (step.scope !== "workspace") return false;
	if (step.kind !== "code") return true;
	return step.verification !== true && step.commitFrom === undefined;
}

export async function executePlan(
	plan: ExecutionPlan,
	adapter: ExecutionSchedulerAdapter,
	signal?: AbortSignal,
): Promise<ExecutionPlanResult> {
	const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
	const loopsById = new Map(plan.loops.map((loop) => [loop.id, loop]));
	const agentSteps: ExecutionPlanAgentStep[] = [];
	for (const step of plan.steps) {
		if (step.kind === "code") {
			if (adapter.runCode === undefined) {
				throw new Error(`execution plan: step '${step.id}' is a code step and this scheduler cannot run one`);
			}
			continue;
		}
		if (step.approvedAuthority === null || step.approvedAuthority !== step.requestedAuthority) {
			throw new Error(`execution plan: step '${step.id}' lacks its requested authority grant`);
		}
		agentSteps.push(step);
	}
	for (const loop of plan.loops) {
		if (loop.checkKind === "agent" && adapter.decideLoop === undefined) {
			throw new Error(`execution plan: loop '${loop.id}' is agent-checked and this scheduler cannot decide one`);
		}
	}
	// A declared boundary that nothing checks is worse than no boundary: the
	// contract reads as confinement and the run has none. Fail closed.
	const enforcesBoundaries = plan.steps.some((step) => step.writes !== undefined);
	if (enforcesBoundaries && (adapter.beginWriteBoundary === undefined || adapter.verifyWriteBoundary === undefined)) {
		throw new Error("execution plan: steps declare write boundaries and this scheduler cannot verify them");
	}
	// Resolve every hard admission fact before reservation or spawn. Code steps
	// are outside admission entirely: they reserve nothing and spawn no worker.
	// Loop attempts are admitted up front too, because the bound is the ceiling
	// an operator approved and a repair must never be admitted mid-run.
	const admissions = agentSteps.map((step) => adapter.preflight(step));
	const reservation = adapter.reserve(plan, admissions);
	const results = new Map<string, ExecutionStepResult>();
	const skipped = new Set<string>();
	const unneeded = new Set<string>();
	const needsDecision: string[] = [];
	const running = new Map<string, { assignmentId: string | null }>();
	/** Per-check verdict, so a loop's resolution is recomputed from live results. */
	const checkPassed = new Map<string, boolean>();
	/** Findings a failed agent verification threaded to its repair attempt. */
	const loopFindings = new Map<string, string>();
	const attemptsRun = new Map<string, number>();
	const repairsRun = new Map<string, number>();
	const revalidations = new Map<string, number>();
	const revalidated: string[] = [];
	const writeBoundaries: ExecutionWriteBoundaryOutcome[] = [];
	/** Monotonic completion order, the only clock staleness needs. */
	let sequence = 0;
	const completedAt = new Map<string, number>();
	let lastMutationSeq = 0;
	let stopped = false;
	// Code steps carry no assignment id, so `cancel` cannot reach them. They are
	// aborted through this signal, which the runner turns into a process-group
	// kill on the whole command tree.
	const codeAbort = new AbortController();
	const cancelOwned = (): void => {
		stopped = true;
		for (const owned of running.values()) if (owned.assignmentId !== null) adapter.cancel(owned.assignmentId);
		codeAbort.abort();
		adapter.releaseUnconsumed(reservation.ownerId);
	};
	signal?.addEventListener("abort", cancelOwned, { once: true });

	const loopOf = (step: ExecutionPlanStep): ExecutionPlanLoop | null =>
		step.loop === undefined ? null : (loopsById.get(step.loop.loopId) ?? null);
	const loopResolved = (loop: ExecutionPlanLoop): boolean =>
		loop.checkStepIds.some((id) => results.has(id) && checkPassed.get(id) === true);

	const recordCompletion = (step: ExecutionPlanStep, result: ExecutionStepResult): void => {
		sequence += 1;
		completedAt.set(step.id, sequence);
		results.set(step.id, result);
		if (isWorkspaceMutator(step)) lastMutationSeq = sequence;
	};

	/**
	 * A failed predecessor normally disqualifies its dependents. Two deliberate
	 * exceptions carry a failure across an edge instead of severing it:
	 *
	 *   - A failed code step under `onFailure: continue`. The red suite's
	 *     verbatim output is the input to the step that repairs it.
	 *   - A failed verification inside a bounded loop, for that loop's own
	 *     repair attempt. That edge is the loop's designed failure path, so it
	 *     carries the red result regardless of the plan's failure policy. Only
	 *     an integrity-invalid result severs it: a run that cannot be trusted
	 *     is not evidence of anything.
	 *
	 * An edge out of a verification is answered by the loop, never by the
	 * verification's own exit status. A gate agent that ran perfectly and
	 * returned `fail` is a successful run and an unmet condition, so reading
	 * `succeeded` here would let a rejected review flow downstream as approval.
	 */
	const dependencyBlocks = (dependency: string, dependent: ExecutionPlanStep): boolean => {
		if (unneeded.has(dependency)) return false;
		if (skipped.has(dependency)) return true;
		const result = results.get(dependency);
		// A boundary violation severs every edge, including a loop's own repair
		// path. The tree was rolled back or left for an operator; either way the
		// answer is not "try again", it is "this step is not allowed to do that".
		if (result?.boundaryViolated === true) return true;
		const source = stepsById.get(dependency);
		const loop = source?.loop?.role === "check" ? loopOf(source) : null;
		if (loop !== null) {
			// Inside the loop, only an untrustworthy result severs the chain; the
			// verdict itself is what the next attempt exists to answer.
			if (dependent.loop?.loopId === loop.id) return result !== undefined && !result.integrityValid;
			return !loopResolved(loop);
		}
		if (result === undefined) return true;
		if (!result.integrityValid) return true;
		if (result.succeeded) return false;
		return !(source?.kind === "code" && plan.onFailure === "continue");
	};

	/**
	 * Handoffs from predecessors that produced a result. Only loop members may
	 * be absent: a resolved loop leaves its later attempts declared and unrun.
	 * Any other missing predecessor stays in the list so projection still fails
	 * loudly rather than quietly handing a step less context than it declared.
	 */
	const handoffsFor = (step: ExecutionPlanStep): ExecutionHandoff[] => {
		const available = step.dependencies.filter((id) => results.has(id) || stepsById.get(id)?.loop === undefined);
		const projected = projectExecutionHandoffs(available, results);
		if (step.loop?.role !== "repair") return projected;
		// A gate's continuation findings, not its raw transcript, are what the
		// repair attempt is answering.
		const findings = loopFindings.get(`${step.loop.loopId}:${step.loop.attempt}`);
		if (findings === undefined) return projected;
		const checkId = loopsById.get(step.loop.loopId)?.checkStepIds[step.loop.attempt - 1];
		return projected.map((handoff) => (handoff.stepId === checkId ? { ...handoff, output: findings } : handoff));
	};

	const isUnneeded = (step: ExecutionPlanStep): boolean => {
		const loop = loopOf(step);
		if (loop === null) return false;
		// Every later attempt of a resolved loop is declared but unnecessary. The
		// first verification always runs: it is the question the loop exists to
		// ask.
		if (step.loop?.role === "check" && step.loop.attempt === 1) return false;
		return loopResolved(loop);
	};

	/**
	 * Open an enforcement window over the steps of one scheduling unit. The
	 * snapshot is taken before anything spawns, so every change the window
	 * produces is inside it.
	 */
	const openBoundary = (window: string, steps: ReadonlyArray<ExecutionPlanStep>): string[] | null => {
		const enforced = steps.filter((step) => step.writes !== undefined).map((step) => step.id);
		if (enforced.length === 0 || adapter.beginWriteBoundary === undefined) return null;
		adapter.beginWriteBoundary(window, enforced);
		return enforced;
	};

	/**
	 * Close the window before any result crosses an edge. A blamed step fails
	 * whatever its exit status said: writing outside the declared boundary is
	 * not a thing a successful run gets to have done, and it is not something a
	 * loop repair can be asked to fix, so the failure is carried on the result
	 * rather than folded into the loop's verdict.
	 */
	const closeBoundary = async (
		window: string,
		enforced: ReadonlyArray<string> | null,
		settled: ReadonlyArray<{ step: ExecutionPlanStep; result: ExecutionStepResult }>,
	): Promise<Array<{ step: ExecutionPlanStep; result: ExecutionStepResult }>> => {
		const verify = adapter.verifyWriteBoundary;
		if (enforced === null || verify === undefined) return [...settled];
		const outcome = await verify(window, enforced);
		writeBoundaries.push(outcome);
		if (!outcome.violated) return [...settled];
		const blamed = new Set(outcome.failedStepIds);
		return settled.map(({ step, result }) =>
			blamed.has(step.id) ? { step, result: { ...result, succeeded: false, boundaryViolated: true } } : { step, result },
		);
	};

	const runCodeStepNode = async (
		step: ExecutionPlanCodeStep,
		handoffs: ReadonlyArray<ExecutionHandoff>,
	): Promise<ExecutionStepResult> => {
		const runCode = adapter.runCode;
		if (runCode === undefined) throw new Error(`execution plan: no runner for code step '${step.id}'`);
		return await runCode(step, handoffs, codeAbort.signal, results);
	};

	/**
	 * Scheduler-enforced staleness. A green verification measured the workspace
	 * as it stood; a workspace step that finishes afterwards makes that green a
	 * statement about a tree nobody has now. Before any dependent may treat the
	 * verification as satisfied, the verification runs again.
	 */
	const revalidateFor = async (wave: ReadonlyArray<string>): Promise<boolean> => {
		const candidates = new Set<string>();
		for (const id of wave) {
			const step = stepsById.get(id);
			if (step === undefined || unneeded.has(id) || skipped.has(id)) continue;
			for (const ancestor of executionPlanAncestors(plan, id)) {
				const source = stepsById.get(ancestor);
				if (source?.kind !== "code" || source.verification !== true) continue;
				const result = results.get(ancestor);
				if (result === undefined || !result.succeeded || !result.integrityValid) continue;
				if ((completedAt.get(ancestor) ?? 0) >= lastMutationSeq) continue;
				candidates.add(ancestor);
			}
		}
		let halt = false;
		for (const id of [...candidates].sort()) {
			const step = stepsById.get(id);
			if (step?.kind !== "code") continue;
			const spent = revalidations.get(id) ?? 0;
			if (spent >= STALENESS_REVALIDATION_LIMIT) {
				throw new Error(
					`execution plan: verification '${id}' exhausted ${STALENESS_REVALIDATION_LIMIT} staleness revalidations`,
				);
			}
			revalidations.set(id, spent + 1);
			revalidated.push(id);
			const window = `revalidate-${id}-${spent + 1}`;
			const enforced = openBoundary(window, [step]);
			const ran = await runCodeStepNode(step, handoffsFor(step));
			const [checked] = await closeBoundary(window, enforced, [{ step, result: ran }]);
			const result = checked?.result ?? ran;
			recordCompletion(step, result);
			const loop = loopOf(step);
			if (step.loop?.role === "check") {
				checkPassed.set(step.id, result.succeeded && result.integrityValid);
				if (loop !== null) attemptsRun.set(loop.id, (attemptsRun.get(loop.id) ?? 0) + 1);
			}
			// A revalidation that comes back red is terminal: the loop that
			// produced the original green has no attempts left to spend on it.
			if (!result.succeeded || !result.integrityValid) {
				if (plan.onFailure === "stop") {
					stopped = true;
					codeAbort.abort();
					adapter.releaseUnconsumed(reservation.ownerId);
					halt = true;
				}
			}
		}
		return halt;
	};

	/** Stop-policy verdict for one settled step. */
	const isPlanFailure = (step: ExecutionPlanStep, result: ExecutionStepResult): boolean => {
		if (result.boundaryViolated === true) return true;
		if (result.succeeded && result.integrityValid) return false;
		if (step.loop?.role !== "check" || !result.integrityValid) return true;
		const loop = loopOf(step);
		// A red verification with attempts left is the loop working as declared.
		return loop === null || step.loop.attempt >= loop.maxAttempts;
	};

	const settleCheck = async (step: ExecutionPlanStep, result: ExecutionStepResult): Promise<void> => {
		const loop = loopOf(step);
		if (loop === null || step.loop?.role !== "check") return;
		const attempt = step.loop.attempt;
		attemptsRun.set(loop.id, (attemptsRun.get(loop.id) ?? 0) + 1);
		// A verification that wrote outside its boundary answered nothing: its
		// verdict describes a tree that has since been rolled back under it.
		if (result.boundaryViolated === true) {
			checkPassed.set(step.id, false);
			return;
		}
		if (loop.checkKind === "code") {
			checkPassed.set(step.id, result.succeeded && result.integrityValid);
			return;
		}
		const decide = adapter.decideLoop;
		if (decide === undefined) throw new Error(`execution plan: loop '${loop.id}' has no decider`);
		if (!result.integrityValid) {
			checkPassed.set(step.id, false);
			return;
		}
		const decision = await decide({
			loop,
			step,
			attempt,
			terminalAttempt: attempt >= loop.maxAttempts,
			result,
			priorResults: results,
		});
		checkPassed.set(step.id, decision.resolved);
		if (decision.findings !== null) loopFindings.set(`${loop.id}:${attempt}`, decision.findings);
		if (decision.needsDecision !== undefined && decision.needsDecision !== null) {
			needsDecision.push(decision.needsDecision);
		}
	};

	const loopOutcomes = (): ExecutionLoopOutcome[] =>
		plan.loops.map((loop) => {
			const attempts = attemptsRun.get(loop.id) ?? 0;
			const repairs = repairsRun.get(loop.id) ?? 0;
			if (loopResolved(loop)) return { loopId: loop.id, resolved: true, attempts, repairs, reason: "resolved" };
			if (attempts === 0) return { loopId: loop.id, resolved: false, attempts, repairs, reason: "loop_not_reached" };
			const ran = loop.checkStepIds.filter((id) => results.has(id)).length;
			const brokenMember = [...loop.checkStepIds, ...loop.repairStepIds].some((id) => {
				const result = results.get(id);
				return result !== undefined && !result.integrityValid;
			});
			const reason: ExecutionLoopReason =
				!brokenMember && ran >= loop.maxAttempts ? "loop_bound_exhausted" : "loop_step_failed";
			return { loopId: loop.id, resolved: false, attempts, repairs, reason };
		});

	try {
		for (const [waveIndex, wave] of plan.waves.entries()) {
			if (stopped || signal?.aborted) break;
			if (await revalidateFor(wave)) break;
			const admitted = wave.flatMap((id) => {
				const step = stepsById.get(id);
				if (!step) throw new Error(`execution plan: unknown scheduled step '${id}'`);
				if (isUnneeded(step)) {
					unneeded.add(step.id);
					return [];
				}
				if (step.dependencies.some((dependency) => dependencyBlocks(dependency, step))) {
					skipped.add(step.id);
					return [];
				}
				return [{ step, handoffs: handoffsFor(step) }];
			});
			const launch = admitted.filter(
				(entry): entry is { step: ExecutionPlanAgentStep; handoffs: ExecutionHandoff[] } => entry.step.kind === "agent",
			);
			const codeWork = admitted.filter(
				(entry): entry is { step: ExecutionPlanCodeStep; handoffs: ExecutionHandoff[] } => entry.step.kind === "code",
			);
			const boundaryWindow = `wave-${waveIndex}`;
			const enforced = openBoundary(
				boundaryWindow,
				admitted.map((entry) => entry.step),
			);
			const started = await Promise.all(
				launch.map(async ({ step, handoffs }) => ({
					step,
					handle: await adapter.run(step, handoffs, { ownerId: reservation.ownerId, memberId: step.id }),
				})),
			);
			for (const { step, handle } of started) running.set(step.id, { assignmentId: handle.assignmentId });
			const onSettled = (step: ExecutionPlanStep, result: ExecutionStepResult): void => {
				if (isPlanFailure(step, result) && plan.onFailure === "stop") {
					stopped = true;
					for (const [runningStepId, owned] of running) {
						if (runningStepId !== step.id && owned.assignmentId !== null) adapter.cancel(owned.assignmentId);
					}
					codeAbort.abort();
					adapter.releaseUnconsumed(reservation.ownerId);
				}
			};
			const ran = await Promise.all([
				...started.map(async ({ step, handle }) => {
					const result = await handle.result;
					onSettled(step, result);
					return { step: step as ExecutionPlanStep, result };
				}),
				...codeWork.map(async ({ step, handoffs }) => {
					const result = await runCodeStepNode(step, handoffs);
					onSettled(step, result);
					return { step: step as ExecutionPlanStep, result };
				}),
			]);
			// The boundary is settled before anything is recorded or handed on, so
			// a rolled-back step never appears upstream of the work it would have
			// contaminated.
			const settled = await closeBoundary(boundaryWindow, enforced, ran);
			for (const { step, result } of settled) {
				running.set(step.id, { assignmentId: result.assignmentId });
				recordCompletion(step, result);
				if (step.loop?.role === "repair") {
					repairsRun.set(step.loop.loopId, (repairsRun.get(step.loop.loopId) ?? 0) + 1);
				}
				running.delete(step.id);
			}
			// Loop continuation is decided after the wave settles, so a gate's
			// verdict is read from a sealed result rather than from a live stream.
			for (const { step, result } of settled) await settleCheck(step, result);
			// A loop that spent its last attempt without converging ends the run
			// under a stop policy, whether the verdict came from an exit code or
			// from a gate that answered "no" perfectly well.
			const exhausted = settled.some(({ step }) => {
				const loop = step.loop?.role === "check" ? loopOf(step) : null;
				return loop !== null && step.loop !== undefined && step.loop.attempt >= loop.maxAttempts && !loopResolved(loop);
			});
			if ((exhausted || settled.some(({ step, result }) => isPlanFailure(step, result))) && plan.onFailure === "stop") {
				stopped = true;
				adapter.releaseUnconsumed(reservation.ownerId);
			}
		}
		return {
			planHash: plan.hash,
			results,
			skipped: [...skipped],
			unneeded: [...unneeded],
			loops: loopOutcomes(),
			revalidated: [...revalidated],
			needsDecision: [...needsDecision],
			writeBoundaries: [...writeBoundaries],
		};
	} catch (error) {
		cancelOwned();
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancelOwned);
		adapter.release(reservation.ownerId);
	}
}
