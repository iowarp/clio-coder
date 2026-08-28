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

import { createHash } from "node:crypto";
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
import { buildDelegationProposalBriefing, validateDelegationPlan } from "./delegation-plan.js";
import {
	type ExecutionPlan,
	type ExecutionPlanCodeStep,
	type ExecutionPlanStep,
	executionPlanAncestors,
	spliceExecutionPlan,
} from "./execution-plan.js";
import { gateRouteCorrelation, requestExecutionRole } from "./execution-role.js";
import { type ExecutionPlanResult, type ExecutionStepResult, executePlan } from "./execution-scheduler.js";
import { deriveFleetCommitAttribution } from "./fleet-commit-attribution.js";
import { gateBaselineFailure, gateFailureLines } from "./fleet-gate.js";
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
	/**
	 * Why a step failed after its own receipt or report succeeded: a gate whose
	 * baseline was green (`gate_not_discriminating`), a missing gate path or
	 * command, or a delegation plan the validator refused (`delegation_plan_*`).
	 */
	failureReason?: string;
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
		if (step.kind === "agent" && step.plan !== undefined) break;
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
	const { dispatch, agents, fleetRootId, workspaceRoot } = input;
	let livePlan = input.plan;
	const replayed = input.resume?.replayed ?? new Map<string, ExecutionStepResult>();
	const notice = (text: string, kind?: "gate" | "write-boundary"): void => input.onNotice?.(text, kind);
	const fleetRunRecord: FleetRunRecord = {
		version: 1,
		id: fleetRootId,
		fleet: input.contractName,
		planHash: livePlan.hash,
		stepIds: livePlan.steps.map((step) => step.id),
		planSteps: livePlan.steps.map((step) => structuredClone(step)),
		vars: { ...(input.vars ?? {}) },
		startedAt: new Date().toISOString(),
		endedAt: null,
		resumedFrom: input.resume?.record.id ?? null,
		steps: [...replayed].map(([stepId, result]) => ({ stepId, result })),
		dynamicPlans: [],
	};
	await writeFleetRun(fleetRunRecord);
	const boundaryEnforcer = createWriteBoundaryEnforcer({
		root: workspaceRoot,
		rootId: fleetRootId,
		boundaryFor: (stepId) => livePlan.steps.find((step) => step.id === stepId)?.writes,
		recordedWritesFor: (stepId) => {
			const step = livePlan.steps.find((entry) => entry.id === stepId);
			// A code step runs a registered command in a subprocess. Nothing
			// enumerates what that command wrote, so the step contributes no record
			// and its window falls back to blaming the whole diff.
			if (step === undefined || step.kind !== "agent") return null;
			const receipt = receiptsByStep.get(stepId);
			if (receipt === undefined) return null;
			return dispatch.observedRunWrites?.(receipt.runId) ?? null;
		},
		onVerdict(verdict, path) {
			// Concurrent changes are reported too. The window did not fail for them
			// and nothing was touched, and an operator whose file changed under a
			// running fleet should hear it from the fleet.
			if (verdict.detail === null) return;
			notice(`write boundary ${verdict.window}: ${verdict.detail} record=${path}`, "write-boundary");
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
		const step = livePlan.steps.find((entry) => entry.id === stepId);
		if (step === undefined) continue;
		const event: FleetRunStepEvent = {
			stepId,
			kind: step.kind,
			waveIndex: fleetPlanWaveIndex(livePlan, stepId),
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
	const planStep = (stepId: string) => livePlan.steps.find((entry) => entry.id === stepId);

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
		result = await executePlan(livePlan, {
			preflight(step) {
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					cwd: workspaceRoot,
					requestOrigin: "user",
					lineage: {
						parentRunId: input.resume?.record.id ?? fleetRootId,
						rootRunId: fleetRootId,
						attempt: 0,
						depth: 1,
					},
					...(step.scope === "readonly" ? { autonomy: "read-only" as const } : {}),
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
				};
				const resolution = dispatch.preview?.(request);
				if (!resolution) throw new Error(`fleet preflight cannot resolve step '${step.id}'`);
				return { step, costUpperBoundUsd: resolution.costUpperBoundUsd, nodeId: resolution.node.id };
			},
			reserve(reservedPlan, admissions) {
				// A fleet of deterministic steps admits no worker and holds no
				// capacity. The reservation authority refuses an empty reservation,
				// correctly: there is nothing to reserve, so nothing is asked of it.
				if (admissions.length === 0) return { ownerId: NO_WORKER_RESERVATION };
				const reservation = dispatch.reservations?.prepare({
					topology: "parallel",
					tasks: admissions.map((admission) => ({
						memberId: admission.step.id,
						wave: fleetPlanWaveIndex(reservedPlan, admission.step.id),
						resolution: dispatch.preview?.({
							agentId: admission.step.agentId,
							executionRole: admission.step.executionRole,
							task: admission.step.task,
							...(admission.step.target !== undefined ? { target: admission.step.target } : {}),
							...(admission.step.profile !== undefined ? { workerProfile: admission.step.profile } : {}),
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
				const parentReceipt = step.planParentId === undefined ? undefined : receiptsByStep.get(step.planParentId);
				if (step.planParentId !== undefined && parentReceipt === undefined) {
					throw new Error(`fleet dynamic step '${step.id}' has no terminal plan-step receipt`);
				}
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					cwd: workspaceRoot,
					predecessorHandoffs: handoffs,
					requestOrigin: "user",
					lineage: {
						parentRunId: parentReceipt?.runId ?? input.resume?.record.id ?? fleetRootId,
						rootRunId: fleetRootId,
						attempt,
						depth: parentReceipt === undefined ? 1 : 2,
					},
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
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
					...(step.plan !== undefined
						? { resultContractOverride: { kind: "delegation-plan" as const } }
						: step.gate !== undefined
							? { resultContractOverride: { kind: "artifact-report" as const } }
							: {}),
					...(step.gate !== undefined ? { fleetGateReceipt: { path: step.gate.path } } : {}),
				};
				if (step.plan?.proposals === true) {
					const proposals: Array<{ agent: string; output: string }> = [];
					for (const agentId of step.plan.roster) {
						const proposal = await dispatch.dispatch({
							agentId,
							executionRole: "researcher",
							task: step.task,
							cwd: workspaceRoot,
							requestOrigin: "user",
							autonomy: "read-only",
							lineage: { parentRunId: fleetRootId, rootRunId: fleetRootId, attempt: 0, depth: 1 },
							resultContractOverride: { kind: "artifact-report" },
							...(step.target !== undefined ? { target: step.target } : {}),
							...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
						});
						void (async () => {
							for await (const _event of proposal.events) {
								/* Proposal events are drained while their final answers are collected. */
							}
						})().catch(() => {});
						const receipt = await proposal.finalPromise;
						const answer = receipt.output?.state === "final" ? receipt.output.text : "[proposal failed]";
						proposals.push({ agent: agentId, output: answer });
					}
					request.briefing = buildDelegationProposalBriefing(proposals);
				}
				const handle = await dispatch.dispatch(request);
				const waveIndex = fleetPlanWaveIndex(livePlan, step.id);
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
					result: handle.finalPromise.then(async (receipt) => {
						if (step.scope === "workspace") {
							validationFresh = false;
							independentReviewFresh = false;
						}
						receipts.push(receipt);
						receiptsByStep.set(step.id, receipt);
						const envelope = dispatch.getRun(receipt.runId);
						const integrityValid = envelope !== null && verifyReceiptIntegrity(receipt, envelope).ok;
						const succeeded = receipt.exitCode === 0 && (receipt.outcome === undefined || receipt.outcome === "succeeded");
						let stepSucceeded = succeeded;
						let failureReason: string | undefined;
						let gatePathHash: string | undefined;
						let delegationPlanHash: string | undefined;
						let delegationPlan: ExecutionStepResult["delegationPlan"];
						if (step.gate !== undefined && succeeded) {
							let gateBytes = "";
							try {
								gateBytes = readFileSync(join(workspaceRoot, step.gate.path), "utf8");
							} catch {
								gateBytes = "";
							}
							gatePathHash = createHash("sha256").update(gateBytes).digest("hex");
							const command = input.commands?.commands.get(step.gate.commandId);
							if (gateBytes.length === 0 || command === undefined) {
								stepSucceeded = false;
								failureReason = gateBytes.length === 0 ? "gate_path_missing" : "gate_command_missing";
							} else {
								const baseline = await runCodeStep({
									stepId: `${step.id}.baseline`,
									command,
									workspaceRoot,
									artifactDir: codeStepDir(fleetRootId),
									substitutions: { path: step.gate.path },
								});
								const baselineFailure = gateBaselineFailure(baseline.report.passed);
								if (baselineFailure !== null) {
									stepSucceeded = false;
									failureReason = baselineFailure;
								}
							}
						}
						if (step.plan !== undefined && succeeded) {
							let value: unknown = null;
							try {
								value = JSON.parse(receipt.output?.state === "final" ? receipt.output.text : "");
							} catch {
								value = null;
							}
							const validated = validateDelegationPlan({
								value,
								roster: step.plan.roster,
								maxTasks: step.plan.maxTasks,
								writes: step.writes ?? [],
							});
							if (!validated.ok) {
								stepSucceeded = false;
								failureReason = validated.reason;
							} else {
								delegationPlanHash = validated.hash;
								delegationPlan = validated.plan;
								fleetRunRecord.dynamicPlans?.push({ stepId: step.id, hash: validated.hash });
								await writeFleetRun(fleetRunRecord);
							}
						}
						// Settle only after the gate baseline and the delegation-plan
						// validation have run: a receipt that succeeded on its own can
						// still fail the step, and the operator must see that reason.
						input.onStepSettled?.({
							stepId: step.id,
							kind: "agent",
							waveIndex,
							assignmentId: handle.runId,
							agentId: step.agentId,
							succeeded: stepSucceeded,
							terminalRunId: receipt.runId,
							costUsd: receipt.costUsd,
							receipt,
							...(failureReason !== undefined ? { failureReason } : {}),
						});
						notice(
							`step ${step.id} ${step.agentId}: ${stepSucceeded ? "succeeded" : "failed"}${failureReason !== undefined ? ` reason=${failureReason}` : ""} assignment=${handle.runId} terminal-run=${receipt.runId} cost=$${receipt.costUsd.toFixed(4)}`,
						);
						return {
							stepId: step.id,
							assignmentId: handle.runId,
							terminalRunId: receipt.runId,
							receiptDigest: receipt.integrity.digest,
							output: receipt.output?.state === "final" ? receipt.output.text : "",
							succeeded: stepSucceeded,
							integrityValid,
							...(failureReason !== undefined ? { failureReason } : {}),
							...(gatePathHash !== undefined ? { gatePathHash } : {}),
							...(delegationPlanHash !== undefined ? { delegationPlanHash } : {}),
							...(delegationPlan !== undefined ? { delegationPlan } : {}),
						};
					}),
				};
			},
			async runCode(step, _handoffs, signal, priorResults) {
				const command = input.commands?.commands.get(step.commandId);
				if (command === undefined) throw new Error(`fleet code step '${step.id}' has no registered command`);
				const isCommit = step.commitFrom !== undefined;
				const evidence = isCommit
					? deriveFleetCommitAttribution({ plan: livePlan, step, priorResults, validationFresh, independentReviewFresh })
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
					...(step.gate !== undefined ? { substitutions: { path: step.gate.path } } : {}),
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
				const waveIndex = fleetPlanWaveIndex(livePlan, step.id);
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
					output: step.gate === undefined ? outcome.output : gateFailureLines(outcome.report.outputExcerpt),
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
				const ancestors = executionPlanAncestors(livePlan, step.id);
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
			spliceAfter(currentPlan, step, stepResult) {
				if (stepResult.delegationPlan === undefined) return null;
				const tasks = stepResult.delegationPlan.tasks.map((task) => {
					const spec = agents.getSpec(task.agent);
					if (spec === null || spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
						throw new Error(`delegation_plan_agent_unavailable:${task.agent}`);
					}
					return {
						id: task.id,
						agentId: task.agent,
						task: task.description,
						dependencies: task.depends_on,
						writes: task.writes,
						...(step.target !== undefined ? { target: step.target } : {}),
						...(step.profile !== undefined ? { profile: step.profile } : {}),
						requestedAuthority: spec.capabilityClass,
						approvedAuthority: spec.capabilityClass,
						expectedResultContract: spec.resultContract.kind,
						executionRole: requestExecutionRole({
							agentId: task.agent,
							resolveFacts: (id) => {
								const candidate = agents.getSpec(id);
								return candidate === null
									? null
									: {
											capabilityClass: candidate.capabilityClass,
											resultContractKind: candidate.resultContract.kind,
										};
							},
						}),
					};
				});
				livePlan = spliceExecutionPlan(currentPlan, step.id, tasks);
				return livePlan;
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
	const required = livePlan.steps.filter((step) => step.loop === undefined && !result.unneeded.includes(step.id));
	const failedLoops = result.loops.filter((loop) => !loop.resolved);
	const succeededStepCount = required.filter((step) => result.results.get(step.id)?.succeeded === true).length;
	return {
		rootId: fleetRootId,
		planHash: input.plan.hash,
		result,
		receipts,
		totalCostUsd: receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0),
		requiredStepCount: required.length,
		succeededStepCount,
		resolvedLoopCount: result.loops.length - failedLoops.length,
		cleanRun: failedLoops.length === 0 && result.skipped.length === 0 && succeededStepCount === required.length,
	};
}
