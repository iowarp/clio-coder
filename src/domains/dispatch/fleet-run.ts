/**
 * The one fleet-run execution path.
 *
 * A compiled fleet plan is driven here and nowhere else, so every surface that
 * starts a fleet gets identical admission, autonomy, receipts, gate decisions,
 * write-boundary enforcement, and durable ledger rows. The operator surface
 * that calls it owns presentation only: this module writes nothing to stdout
 * and reports progress through callbacks.
 *
 * Everything the run needs is passed in. The module resolves no contract by
 * itself, loads no domain, and reads no configuration, which is what lets a
 * headless CLI invocation and an interactive approval share it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attributeCommitMessage } from "../../core/commit-attribution.js";
import { clioStateDir } from "../../core/xdg.js";
import type { FleetCommandRegistry } from "../agents/fleet-commands.js";
import type { FleetContract } from "../agents/fleet-contract.js";
import { resultContractAuthorship } from "../agents/result-contract.js";
import type { AgentSpec } from "../agents/spec.js";
import { runCodeStep } from "./code-step.js";
import { codeStepDir, writeCodeStepRecord } from "./code-step-store.js";
import type { DispatchContract, DispatchRequest } from "./contract.js";
import {
	type ExecutionPlan,
	type ExecutionPlanCodeStep,
	type ExecutionPlanStep,
	executionPlanAncestors,
} from "./execution-plan.js";
import { gateRouteCorrelation } from "./execution-role.js";
import { type ExecutionPlanResult, type ExecutionStepResult, executePlan } from "./execution-scheduler.js";
import { deriveFleetCommitAttribution } from "./fleet-commit-attribution.js";
import {
	decideReviewGate,
	type GateDecisionCorrelation,
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "./gate-decisions.js";
import { verifyReceiptIntegrity } from "./receipt-integrity.js";
import { type FleetRunRecord, writeFleetRun } from "./state.js";
import type { RunReceipt } from "./types.js";
import { createWriteBoundaryEnforcer } from "./write-boundary-enforcer.js";

/** Owner id for a plan with no model runs; it holds nothing to release. */
const NO_WORKER_RESERVATION = "fleet-no-worker-reservation";

/** Recipe lookup for the agents a plan names; the agents domain owns the registry. */
export interface FleetRunAgentAccess {
	getSpec(agentId: string): AgentSpec | null;
}

/** One step reaching a runnable state, reported the moment its identity exists. */
export interface FleetRunStepEvent {
	stepId: string;
	kind: ExecutionPlanStep["kind"];
	/** Index of the plan wave this step belongs to. */
	waveIndex: number;
	/** Assignment id for an agent step, or the deterministic run id for a code step. */
	assignmentId: string;
	agentId?: string;
	commandId?: string;
	/** True when this event projects a result retained from an earlier run. */
	replayed?: true;
}

/** One settled step, after its receipt or deterministic report is sealed. */
export interface FleetRunStepOutcome extends FleetRunStepEvent {
	succeeded: boolean;
	/** Terminal run id, which is the receipt id for an agent step. */
	terminalRunId: string;
	costUsd: number;
	/** The sealed agent receipt when this was an agent step. */
	receipt?: RunReceipt;
	/** The durable code-step record when this was a deterministic step. */
	codeStep?: Awaited<ReturnType<typeof runCodeStep>>["record"];
	/** The durable code-step record path when this was a deterministic step. */
	recordPath?: string;
	/** The scheduler result retained for a replayed step. */
	result?: ExecutionStepResult;
}

export interface FleetResumeStepDiff {
	index: number;
	prior: unknown;
	current: unknown;
	priorId: string;
	currentId: string;
}

export type FleetResumeRefusal =
	| { ok: false; reason: "fleet-name"; priorFleet: string; currentFleet: string }
	| { ok: false; reason: "vars" }
	| {
			ok: false;
			reason: "plan-hash";
			priorHash: string;
			currentHash: string;
			diff: ReadonlyArray<FleetResumeStepDiff>;
	  };

export type FleetResumePlan = { ok: true; replayed: ReadonlyMap<string, ExecutionStepResult> } | FleetResumeRefusal;

function sortedVars(vars: Readonly<Record<string, string>>): string {
	return JSON.stringify(Object.entries(vars).sort());
}

function stepIdentity(step: unknown): string {
	if (typeof step === "string") return step;
	if (typeof step === "object" && step !== null && "id" in step && typeof step.id === "string") return step.id;
	return "(missing)";
}

/** Validate a prior record and retain its longest ordered successful prefix. */
export function planFleetResume(
	record: FleetRunRecord,
	plan: ExecutionPlan,
	contract: Pick<FleetContract, "name">,
	vars: Readonly<Record<string, string>>,
): FleetResumePlan {
	if (record.fleet !== contract.name) {
		return { ok: false, reason: "fleet-name", priorFleet: record.fleet, currentFleet: contract.name };
	}
	if (sortedVars(record.vars) !== sortedVars(vars)) return { ok: false, reason: "vars" };
	if (record.planHash !== plan.hash) {
		const priorSteps = record.planSteps ?? record.stepIds;
		const width = Math.max(priorSteps.length, plan.steps.length);
		const diff: FleetResumeStepDiff[] = [];
		for (let index = 0; index < width; index += 1) {
			const prior = priorSteps[index] ?? "(missing)";
			const current = plan.steps[index] ?? "(missing)";
			if (JSON.stringify(prior) === JSON.stringify(current)) continue;
			diff.push({ index, prior, current, priorId: stepIdentity(prior), currentId: stepIdentity(current) });
		}
		return {
			ok: false,
			reason: "plan-hash",
			priorHash: record.planHash,
			currentHash: plan.hash,
			diff,
		};
	}
	const priorByStep = new Map(record.steps.map((entry) => [entry.stepId, entry.result]));
	const replayed = new Map<string, ExecutionStepResult>();
	for (const step of plan.steps) {
		const result = priorByStep.get(step.id);
		if (result === undefined || !result.succeeded || !result.integrityValid) break;
		replayed.set(step.id, result);
	}
	return { ok: true, replayed };
}

export interface ExecuteFleetRunInput {
	plan: ExecutionPlan;
	/** Contract name, used for the deterministic commit subject only. */
	contractName: string;
	/** Registered command bindings; required when the plan carries code steps. */
	commands: FleetCommandRegistry | null;
	workspaceRoot: string;
	/** Lineage root every step in this run shares. */
	fleetRootId: string;
	dispatch: DispatchContract;
	agents: FleetRunAgentAccess;
	/** Whether a commit node stamps Clio's attribution trailers. */
	attributionEnabled: boolean;
	/** Variables rendered into the contract body and sealed into the run record. */
	vars?: Readonly<Record<string, string>>;
	/** A validated prior run and the successful prefix retained from it. */
	resume?: { record: FleetRunRecord; replayed: ReadonlyMap<string, ExecutionStepResult> };
	onStepDispatched?: (event: FleetRunStepEvent) => void;
	onStepSettled?: (outcome: FleetRunStepOutcome) => void;
	/** Operator-facing lines the caller renders wherever it shows the run. */
	onNotice?: (text: string, kind?: "gate" | "write-boundary") => void;
}

export interface FleetRunOutcome {
	rootId: string;
	planHash: string;
	result: ExecutionPlanResult;
	receipts: ReadonlyArray<RunReceipt>;
	totalCostUsd: number;
	/** Steps that ran unconditionally, excluding nodes a resolved loop skipped. */
	requiredStepCount: number;
	succeededStepCount: number;
	resolvedLoopCount: number;
	/** True when every required step succeeded and every loop converged. */
	cleanRun: boolean;
}

/** Sealed independence facts between the work under review and its reviewer. */
function fleetGateCorrelation(subject: RunReceipt, decider: RunReceipt): GateDecisionCorrelation {
	const facts = (receipt: RunReceipt) => ({
		agentId: receipt.agentId,
		targetId: receipt.targetId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		nodeId: receipt.node?.id ?? "local",
	});
	const { agent, target, modelFamily, runtime, node, independent } = gateRouteCorrelation(
		facts(subject),
		facts(decider),
	);
	return { agent, target, modelFamily, runtime, node, independent };
}

export function fleetPlanWaveIndex(plan: ExecutionPlan, stepId: string): number {
	return plan.waves.findIndex((wave) => wave.includes(stepId));
}

/**
 * Run a compiled fleet plan to completion.
 *
 * The caller has already compiled the plan, resolved every agent, and passed
 * preflight; this drives the scheduler and seals the durable artifacts. It
 * throws only when the scheduler itself cannot proceed, so a red step is a
 * result rather than an exception.
 */
export async function executeFleetRun(input: ExecuteFleetRunInput): Promise<FleetRunOutcome> {
	const { plan, dispatch, agents, fleetRootId, workspaceRoot } = input;
	const replayed = input.resume?.replayed ?? new Map<string, ExecutionStepResult>();
	const notice = (text: string, kind?: "gate" | "write-boundary"): void => input.onNotice?.(text, kind);
	const fleetRunRecord: FleetRunRecord = {
		version: 1,
		id: fleetRootId,
		fleet: input.contractName,
		planHash: plan.hash,
		stepIds: plan.steps.map((step) => step.id),
		planSteps: plan.steps.map((step) => structuredClone(step)),
		vars: { ...(input.vars ?? {}) },
		startedAt: new Date().toISOString(),
		endedAt: null,
		resumedFrom: input.resume?.record.id ?? null,
		steps: [...replayed].map(([stepId, result]) => ({ stepId, result })),
	};
	await writeFleetRun(fleetRunRecord);
	const boundaryByStep = new Map(plan.steps.map((step) => [step.id, step.writes]));
	const boundaryEnforcer = createWriteBoundaryEnforcer({
		root: workspaceRoot,
		rootId: fleetRootId,
		boundaryFor: (stepId) => boundaryByStep.get(stepId),
		onVerdict(verdict, path) {
			if (verdict.reason === null) return;
			notice(`write boundary ${verdict.window}: ${verdict.detail ?? verdict.reason} record=${path}`, "write-boundary");
		},
	});
	const receipts: RunReceipt[] = [];
	const receiptsByStep = new Map<string, RunReceipt>();
	for (const [stepId, replayedResult] of replayed) {
		try {
			const receipt = JSON.parse(
				readFileSync(join(clioStateDir(), "receipts", `${replayedResult.terminalRunId}.json`), "utf8"),
			) as RunReceipt;
			receiptsByStep.set(stepId, receipt);
		} catch {
			// Deterministic results and unavailable historical receipts need no receipt projection.
		}
		const step = plan.steps.find((entry) => entry.id === stepId);
		if (step === undefined) continue;
		const event: FleetRunStepEvent = {
			stepId,
			kind: step.kind,
			waveIndex: fleetPlanWaveIndex(plan, stepId),
			assignmentId: replayedResult.assignmentId,
			...(step.kind === "agent" ? { agentId: step.agentId } : { commandId: step.commandId }),
			replayed: true,
		};
		input.onStepDispatched?.(event);
		input.onStepSettled?.({
			...event,
			succeeded: true,
			terminalRunId: replayedResult.terminalRunId,
			costUsd: receiptsByStep.get(stepId)?.costUsd ?? 0,
			result: replayedResult,
		});
	}
	const planStep = (stepId: string) => plan.steps.find((entry) => entry.id === stepId);

	// Freshness is coordinator-owned execution state. Worker prose cannot set
	// either flag: a successful deterministic verification sets the first, and
	// an integrity-valid independent gate decision sets the second. Any later
	// workspace agent invalidates both before a commit may read them.
	let validationFresh = false;
	let independentReviewFresh = false;

	/**
	 * The commit message is the words of the agent that produced the work, and
	 * only that agent's. Candidates are consulted newest first; when none of
	 * them authored one, code writes a deterministic line rather than inventing
	 * a sentence or reusing somebody else's.
	 */
	const commitMessageFor = (
		step: ExecutionPlanCodeStep,
		priorResults: ReadonlyMap<string, { output: string }>,
	): string => {
		for (const candidate of step.commitFrom ?? []) {
			const source = planStep(candidate);
			const result = priorResults.get(candidate);
			if (source === undefined || source.kind !== "agent" || result === undefined) continue;
			const resultContract = agents.getSpec(source.agentId)?.resultContract ?? null;
			if (resultContract === null) continue;
			const authored = resultContractAuthorship(resultContract, result.output);
			if (authored.commitMessage !== null) return authored.commitMessage;
			if (authored.summary !== null) return `clio(${fleetRootId}): ${authored.summary}`;
		}
		return `clio(${fleetRootId}): ${input.contractName} ${step.id}`;
	};

	let result: ExecutionPlanResult;
	try {
		result = await executePlan(plan, {
			preflight(step) {
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					requestOrigin: "user",
					lineage: {
						parentRunId: input.resume?.record.id ?? fleetRootId,
						rootRunId: fleetRootId,
						attempt: 0,
						depth: 1,
					},
					...(step.scope === "readonly" ? { autonomy: "read-only" as const } : {}),
				};
				const resolution = dispatch.preview?.(request);
				if (!resolution) throw new Error(`fleet preflight cannot resolve step '${step.id}'`);
				return { step, costUpperBoundUsd: resolution.costUpperBoundUsd, nodeId: resolution.node.id };
			},
			reserve(_plan, admissions) {
				// A fleet of deterministic steps admits no worker and holds no
				// capacity. The reservation authority refuses an empty reservation,
				// correctly: there is nothing to reserve, so nothing is asked of it.
				if (admissions.length === 0) return { ownerId: NO_WORKER_RESERVATION };
				const reservation = dispatch.reservations?.prepare({
					topology: "parallel",
					tasks: admissions.map((admission) => ({
						memberId: admission.step.id,
						wave: fleetPlanWaveIndex(plan, admission.step.id),
						resolution: dispatch.preview?.({
							agentId: admission.step.agentId,
							executionRole: admission.step.executionRole,
							task: admission.step.task,
						}) as NonNullable<ReturnType<NonNullable<DispatchContract["preview"]>>>,
					})),
				});
				if (!reservation) throw new Error("fleet whole-plan reservation is unavailable");
				return { ownerId: reservation.ownerId };
			},
			async run(step, handoffs, reservation, ledger) {
				// A loop repair is attempt n of the same logical work, so it enters
				// the run ledger as one: recovery evidence, not a fresh observation.
				const attempt = step.loop?.role === "repair" ? step.loop.attempt : 0;
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					predecessorHandoffs: handoffs,
					requestOrigin: "user",
					lineage: { parentRunId: input.resume?.record.id ?? fleetRootId, rootRunId: fleetRootId, attempt, depth: 1 },
					reservation,
					...(ledger !== undefined ? { ledger } : {}),
					...(step.loop?.role === "check"
						? {
								gate: {
									role: "reviewer" as const,
									group: `${fleetRootId}:${step.loop.loopId}`,
									cycle: step.loop.attempt,
									subjects: handoffs.map((handoff) => ({
										runId: handoff.terminalRunId,
										digest: handoff.receiptDigest,
									})),
								},
							}
						: {}),
					...(step.scope === "readonly" ? { autonomy: "read-only" as const } : {}),
				};
				const handle = await dispatch.dispatch(request);
				const waveIndex = fleetPlanWaveIndex(plan, step.id);
				input.onStepDispatched?.({
					stepId: step.id,
					kind: "agent",
					waveIndex,
					assignmentId: handle.runId,
					agentId: step.agentId,
				});
				void (async () => {
					for await (const _event of handle.events) {
						/* background display drain */
					}
				})().catch(() => {});
				return {
					assignmentId: handle.runId,
					result: handle.finalPromise.then((receipt) => {
						if (step.scope === "workspace") {
							validationFresh = false;
							independentReviewFresh = false;
						}
						receipts.push(receipt);
						receiptsByStep.set(step.id, receipt);
						const envelope = dispatch.getRun(receipt.runId);
						const integrityValid = envelope !== null && verifyReceiptIntegrity(receipt, envelope).ok;
						const succeeded = receipt.exitCode === 0 && (receipt.outcome === undefined || receipt.outcome === "succeeded");
						input.onStepSettled?.({
							stepId: step.id,
							kind: "agent",
							waveIndex,
							assignmentId: handle.runId,
							agentId: step.agentId,
							succeeded,
							terminalRunId: receipt.runId,
							costUsd: receipt.costUsd,
							receipt,
						});
						notice(
							`step ${step.id} ${step.agentId}: ${succeeded ? "succeeded" : "failed"} assignment=${handle.runId} terminal-run=${receipt.runId} cost=$${receipt.costUsd.toFixed(4)}`,
						);
						return {
							stepId: step.id,
							assignmentId: handle.runId,
							terminalRunId: receipt.runId,
							receiptDigest: receipt.integrity.digest,
							output: receipt.output?.state === "final" ? receipt.output.text : "",
							succeeded,
							integrityValid,
						};
					}),
				};
			},
			async runCode(step, _handoffs, signal, priorResults) {
				const command = input.commands?.commands.get(step.commandId);
				if (command === undefined) throw new Error(`fleet code step '${step.id}' has no registered command`);
				const isCommit = step.commitFrom !== undefined;
				const evidence = isCommit
					? deriveFleetCommitAttribution({ plan, step, priorResults, validationFresh, independentReviewFresh })
					: null;
				if (!isCommit && step.scope === "workspace" && step.verification !== true) {
					validationFresh = false;
					independentReviewFresh = false;
				}
				const originalMessage = isCommit ? commitMessageFor(step, priorResults) : null;
				const outcome = await runCodeStep({
					stepId: step.id,
					command,
					workspaceRoot,
					artifactDir: codeStepDir(fleetRootId),
					signal,
					...(isCommit && evidence !== null && originalMessage !== null
						? {
								substitutions: {
									commitMessage: attributeCommitMessage(originalMessage, evidence, input.attributionEnabled),
								},
								requireWorkspaceChanges: true,
								commitAttribution: { enabled: input.attributionEnabled, evidence },
							}
						: {}),
				});
				if (step.verification === true) validationFresh = outcome.report.passed;
				const recordPath = await writeCodeStepRecord(fleetRootId, outcome.record);
				const waveIndex = fleetPlanWaveIndex(plan, step.id);
				const event = {
					stepId: step.id,
					kind: "code" as const,
					waveIndex,
					assignmentId: outcome.record.runId,
					commandId: command.id,
				};
				input.onStepDispatched?.(event);
				input.onStepSettled?.({
					...event,
					succeeded: outcome.report.passed,
					terminalRunId: outcome.record.runId,
					costUsd: 0,
					codeStep: outcome.record,
					recordPath,
				});
				notice(
					`step ${step.id} code:${command.id}: ${outcome.report.passed ? "passed" : "failed"} exit=${outcome.report.exitCode} ${outcome.record.durationMs}ms record=${recordPath}`,
				);
				return {
					stepId: step.id,
					assignmentId: outcome.record.runId,
					terminalRunId: outcome.record.runId,
					receiptDigest: outcome.record.reportDigest,
					output: outcome.output,
					succeeded: outcome.report.passed,
					// The runner authored this report itself, so its provenance is
					// valid by construction; only the command's verdict can be red.
					integrityValid: true,
				};
			},
			async decideLoop({ loop, step, attempt, terminalAttempt, result: stepResult }) {
				// The coordinator's review policy: pass ends the loop, a failure with
				// attempts left earns one repair, and the same failure at the bound is
				// the terminal answer. `revise` is never a verdict the reviewed model
				// authors.
				const decider = receiptsByStep.get(step.id);
				// The subject is the work under review: the most recent agent run
				// upstream of this verification. A direct dependency is not enough,
				// because a loop's declared dependency is another loop's deterministic
				// check, which produced no receipt at all.
				const ancestors = executionPlanAncestors(plan, step.id);
				let subject: RunReceipt | undefined;
				for (const [stepId, receipt] of receiptsByStep) {
					if (ancestors.has(stepId)) subject = receipt;
				}
				if (decider === undefined || subject === undefined) {
					return {
						resolved: false,
						findings: null,
						needsDecision: `loop '${loop.id}' cycle ${attempt} has no sealed reviewer or subject receipt`,
					};
				}
				const correlation = fleetGateCorrelation(subject, decider);
				const decided = decideReviewGate({
					group: `${fleetRootId}:${loop.id}`,
					cycle: attempt,
					terminalCycle: terminalAttempt,
					subjects: [{ runId: subject.runId, digest: subject.integrity.digest }],
					decider: { runId: decider.runId, digest: decider.integrity.digest },
					correlation,
					output: stepResult.output,
				});
				independentReviewFresh = decided.verdict === "pass" && correlation.independent;
				if (!replayed.has(step.id)) {
					const staged = stagePendingGateDecision(decided.draft);
					const { path: decisionPath } = materializePendingGateDecision(staged);
					notice(
						`loop ${loop.id} cycle ${attempt}: ${decided.draft.outcome}${decided.draft.detail === undefined ? "" : ` (${decided.draft.detail})`} decision=${decisionPath}`,
						"gate",
					);
				}
				return { resolved: decided.verdict === "pass", findings: decided.findings, needsDecision: decided.needsDecision };
			},
			beginWriteBoundary: (window, stepIds) => boundaryEnforcer.begin(window, stepIds),
			verifyWriteBoundary: (window, stepIds) => boundaryEnforcer.verify(window, stepIds),
			cancel: (assignmentId) => dispatch.abort(assignmentId),
			release: (ownerId) => {
				if (ownerId === NO_WORKER_RESERVATION) return;
				dispatch.reservations?.rollbackUnconsumed(ownerId);
			},
			releaseUnconsumed: (ownerId) => {
				if (ownerId === NO_WORKER_RESERVATION) return;
				dispatch.reservations?.rollbackUnconsumed(ownerId);
			},
			onStepSettled: async (step, stepResult) => {
				fleetRunRecord.steps.push({ stepId: step.id, result: stepResult });
				await writeFleetRun(fleetRunRecord);
			},
			replayed,
		});
	} catch (error) {
		fleetRunRecord.endedAt = new Date().toISOString();
		await writeFleetRun(fleetRunRecord);
		throw error;
	}
	fleetRunRecord.endedAt = new Date().toISOString();
	await writeFleetRun(fleetRunRecord);

	// A loop is judged by whether it converged, not attempt by attempt: a red
	// verification that a later attempt fixed is the loop working as declared,
	// and a node a resolved loop made unnecessary never had to run at all.
	const required = plan.steps.filter((step) => step.loop === undefined && !result.unneeded.includes(step.id));
	const failedLoops = result.loops.filter((loop) => !loop.resolved);
	const succeededStepCount = required.filter((step) => result.results.get(step.id)?.succeeded === true).length;
	return {
		rootId: fleetRootId,
		planHash: plan.hash,
		result,
		receipts,
		totalCostUsd: receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0),
		requiredStepCount: required.length,
		succeededStepCount,
		resolvedLoopCount: result.loops.length - failedLoops.length,
		cleanRun: failedLoops.length === 0 && result.skipped.length === 0 && succeededStepCount === required.length,
	};
}
