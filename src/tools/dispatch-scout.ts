/** Authenticated two-call Scout continuation protocol. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../core/xdg.js";
import { parseScoutResult, resultContractSourceId, type ScoutResult } from "../domains/agents/result-contract.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type {
	DispatchAgentPlanResolution,
	DispatchContract,
	DispatchPlanTaskResolution,
	DispatchRequest,
} from "../domains/dispatch/contract.js";
import type { ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { executePlan } from "../domains/dispatch/execution-scheduler.js";
import { verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import { sameRouteIdentity } from "../domains/dispatch/route-decision.js";
import type { RoutingIntent } from "../domains/dispatch/routing-intent.js";
import { compileScoutTransition, type ScoutAgentBinding } from "../domains/dispatch/scout-transition.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import type { ResolvedDispatchPlanArtifact } from "./dispatch-plan.js";

export const MAX_SCOUT_PLAN_DEADLINE_MS = 3_600_000;

export interface ScoutContinuationRef {
	runId: string;
	receiptDigest: string;
}

export type ScoutTransitionDetail =
	| {
			kind: "settled";
			sourceRunId: string;
			sourceReceiptDigest: string;
			findings: ScoutResult["findings"];
	  }
	| {
			kind: "proposed";
			sourceRunId: string;
			sourceReceiptDigest: string;
			subtaskCount: number;
			continueWith: { from_scout: { run_id: string; receipt_digest: string } };
	  };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scoutContinuationRefFromArgs(
	args: Record<string, unknown>,
): { ok: true; ref: ScoutContinuationRef | null } | { ok: false; message: string } {
	if (!Object.hasOwn(args, "from_scout")) return { ok: true, ref: null };
	if (Object.keys(args).some((key) => key !== "from_scout")) {
		return {
			ok: false,
			message: "dispatch: from_scout cannot be combined with task, agent, route, topology, or tool controls",
		};
	}
	const value = args.from_scout;
	if (!record(value) || Object.keys(value).sort().join("\u0000") !== "receipt_digest\u0000run_id") {
		return { ok: false, message: "dispatch: from_scout requires exactly run_id and receipt_digest" };
	}
	if (typeof value.run_id !== "string" || value.run_id.trim().length === 0) {
		return { ok: false, message: "dispatch: from_scout.run_id must be non-empty" };
	}
	if (typeof value.receipt_digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.receipt_digest)) {
		return { ok: false, message: "dispatch: from_scout.receipt_digest must be a sha256 digest" };
	}
	return { ok: true, ref: { runId: value.run_id.trim(), receiptDigest: value.receipt_digest } };
}

export interface VerifiedScoutSource {
	envelope: RunEnvelope;
	receipt: RunReceipt;
	scout: ScoutResult;
	spec: AgentSpec;
}

function validateScoutSource(
	receipt: RunReceipt,
	envelope: RunEnvelope,
	agentSpecs: ReadonlyArray<AgentSpec>,
): VerifiedScoutSource {
	const integrity = verifyReceiptIntegrity(receipt, envelope);
	if (!integrity.ok) throw new Error(`dispatch: Scout source receipt failed integrity: ${integrity.reason}`);
	if (receipt.exitCode !== 0 || (receipt.outcome !== undefined && receipt.outcome !== "succeeded")) {
		throw new Error("dispatch: Scout source did not succeed");
	}
	const spec = agentSpecs.find((candidate) => candidate.id === receipt.agentId);
	if (spec === undefined || spec.resultContract.kind !== "scout-report") {
		throw new Error("dispatch: Scout source agent no longer declares scout-report");
	}
	const fact = receipt.quality.resultContract;
	if (fact === null || fact.conformance !== "pass" || fact.sourceId !== resultContractSourceId(spec.resultContract)) {
		throw new Error("dispatch: Scout source lacks an exact passing result-contract fact");
	}
	if (receipt.output?.state !== "final") throw new Error("dispatch: Scout source has no sealed final output");
	const scout = parseScoutResult(receipt.output.text);
	if (scout === null) throw new Error("dispatch: Scout source output does not match the current strict contract");
	return { envelope, receipt, scout, spec };
}

export function loadVerifiedScoutSource(input: {
	ref: ScoutContinuationRef;
	dispatch: Pick<DispatchContract, "getRun">;
	agentSpecs: ReadonlyArray<AgentSpec>;
}): VerifiedScoutSource {
	const envelope = input.dispatch.getRun(input.ref.runId);
	if (envelope === null) throw new Error(`dispatch: Scout source run '${input.ref.runId}' is unavailable`);
	const receiptPath = envelope.receiptPath ?? join(clioStateDir(), "receipts", `${input.ref.runId}.json`);
	if (!existsSync(receiptPath)) throw new Error(`dispatch: Scout source receipt '${input.ref.runId}' is unavailable`);
	let receipt: RunReceipt;
	try {
		receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RunReceipt;
	} catch (error) {
		throw new Error(
			`dispatch: Scout source receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (receipt.runId !== input.ref.runId) throw new Error("dispatch: Scout source receipt contains another run id");
	const source = validateScoutSource(receipt, envelope, input.agentSpecs);
	if (receipt.integrity.digest !== input.ref.receiptDigest)
		throw new Error("dispatch: Scout source receipt digest does not match");
	return source;
}

export function scoutTransitionDetail(input: {
	receipt: RunReceipt;
	envelope: RunEnvelope;
	agentSpecs: ReadonlyArray<AgentSpec>;
}): ScoutTransitionDetail | null {
	try {
		const source = validateScoutSource(input.receipt, input.envelope, input.agentSpecs);
		return source.scout.needsSplit
			? {
					kind: "proposed",
					sourceRunId: source.receipt.runId,
					sourceReceiptDigest: source.receipt.integrity.digest,
					subtaskCount: source.scout.proposedSubtasks.length,
					continueWith: {
						from_scout: { run_id: source.receipt.runId, receipt_digest: source.receipt.integrity.digest },
					},
				}
			: {
					kind: "settled",
					sourceRunId: source.receipt.runId,
					sourceReceiptDigest: source.receipt.integrity.digest,
					findings: source.scout.findings.map((finding) => ({ ...finding })),
				};
	} catch {
		return null;
	}
}

export interface PreparedScoutContinuation {
	artifact: ResolvedDispatchPlanArtifact;
	requests: DispatchRequest[];
	resolutions: DispatchPlanTaskResolution[];
	executionPlan: ExecutionPlan;
}

export function scoutPlanAuthorityGranted(
	artifact: ResolvedDispatchPlanArtifact,
	operatorApproved: boolean,
	fullAuto: boolean,
): boolean {
	return artifact.tasks.every(
		(task) =>
			task.authorityGrant !== null &&
			((task.authorityGrant.basis === "operator-plan-approval" && operatorApproved) ||
				(task.authorityGrant.basis === "full-auto-policy" && fullAuto)),
	);
}

/** Execute one already-authenticated Scout dependency plan through the shared scheduler. */
export async function runScoutContinuationPlan<T, S>(input: {
	dispatch: Pick<DispatchContract, "abort" | "dispatch" | "preview" | "reservations">;
	plan: ExecutionPlan;
	artifact: ResolvedDispatchPlanArtifact;
	requests: ReadonlyArray<DispatchRequest>;
	reservationOwnerId: string;
	signal?: AbortSignal;
	register(
		handle: Awaited<ReturnType<DispatchContract["dispatch"]>>,
		agentId: string,
	): Promise<{ receipt: RunReceipt; summary: S }>;
	complete(receipt: RunReceipt, summary: S): { value: T; integrityValid: boolean };
}): Promise<{ runs: T[]; skipped: ReadonlyArray<string> }> {
	if (input.artifact.deadlineMs === null) throw new Error("Scout dependency plan has no whole-plan deadline");
	const assignmentDeadlineAt = Date.now() + input.artifact.deadlineMs;
	const completedByStep = new Map<string, T>();
	const byStep = new Map(
		input.artifact.tasks.map((task, index) => [task.stepId, { task, request: input.requests[index] }]),
	);
	const result = await executePlan(
		input.plan,
		{
			preflight(step) {
				const bound = byStep.get(step.id);
				if (bound?.request === undefined) throw new Error(`Scout step '${step.id}' has no trusted request`);
				const resolution = input.dispatch.preview?.(bound.request);
				if (resolution === undefined) throw new Error(`Scout step '${step.id}' cannot be preflighted`);
				const approved = bound.task.agentDecision?.selected;
				if (
					approved === undefined ||
					resolution.agentId !== approved.agentId ||
					resolution.specFingerprint !== approved.specFingerprint ||
					resolution.targetId !== approved.targetId ||
					resolution.wireModelId !== approved.modelId ||
					resolution.runtimeId !== approved.runtimeId ||
					resolution.node.id !== approved.nodeId ||
					resolution.node.kind !== bound.task.nodeKind ||
					resolution.node.host !== bound.task.nodeHost ||
					resolution.thinkingLevel !== (approved.thinkingLevel ?? null) ||
					resolution.toolSignature !== approved.toolSignature ||
					resolution.endpointIdentityHash !== approved.endpointIdentityHash ||
					resolution.settingsFingerprint !== approved.settingsFingerprint
				) {
					throw new Error(`Scout step '${step.id}' drifted from its approved route`);
				}
				return { step, costUpperBoundUsd: resolution.costUpperBoundUsd, nodeId: resolution.node.id };
			},
			reserve(_plan, admissions) {
				const cost = admissions.reduce((sum, admission) => sum + admission.costUpperBoundUsd, 0);
				if (!Number.isFinite(cost) || cost > input.artifact.costCeilingUsd) {
					throw new Error("Scout dependency plan drifted above its approved cost ceiling");
				}
				return { ownerId: input.reservationOwnerId };
			},
			async run(step, handoffs, reservation) {
				const bound = byStep.get(step.id);
				if (bound?.request === undefined) throw new Error(`Scout step '${step.id}' has no trusted request`);
				const request: DispatchRequest = {
					...bound.request,
					predecessorHandoffs: handoffs,
					reservation,
					assignmentDeadlineAt,
				};
				const handle = await input.dispatch.dispatch(request);
				return {
					assignmentId: handle.runId,
					result: input.register(handle, request.agentId).then(({ receipt, summary }) => {
						const completed = input.complete(receipt, summary);
						completedByStep.set(step.id, completed.value);
						return {
							stepId: step.id,
							assignmentId: handle.runId,
							terminalRunId: receipt.runId,
							receiptDigest: receipt.integrity.digest,
							output: receipt.output?.state === "final" ? receipt.output.text : "",
							succeeded: receipt.exitCode === 0 && (receipt.outcome === undefined || receipt.outcome === "succeeded"),
							integrityValid: completed.integrityValid,
						};
					}),
				};
			},
			cancel: (assignmentId) => input.dispatch.abort(assignmentId),
			release: (ownerId) => input.dispatch.reservations?.rollbackUnconsumed(ownerId),
			releaseUnconsumed: (ownerId) => input.dispatch.reservations?.rollbackUnconsumed(ownerId),
		},
		input.signal,
	);
	return {
		runs: input.plan.steps.flatMap((step) => {
			const completed = completedByStep.get(step.id);
			return completed === undefined ? [] : [completed];
		}),
		skipped: result.skipped,
	};
}

export function prepareScoutContinuation(input: {
	source: VerifiedScoutSource;
	authorization: "operator-plan-approval" | "full-auto-policy";
	planAgentSelection: DispatchContract["planAgentSelection"];
	costCeilingUsd: number;
}): PreparedScoutContinuation {
	if (!input.source.scout.needsSplit) throw new Error("dispatch: Scout phase is settled and has no continuation plan");
	const proposals: Array<
		DispatchAgentPlanResolution & { subtask: ScoutResult["proposedSubtasks"][number]; routingIntent: RoutingIntent }
	> = [];
	for (const subtask of input.source.scout.proposedSubtasks) {
		const sourceIntent = input.source.receipt.routingIntent;
		const routingIntent: RoutingIntent =
			input.authorization === "full-auto-policy"
				? { ...sourceIntent, requiredCapabilities: [...sourceIntent.requiredCapabilities], failover: "approved" }
				: {
						...sourceIntent,
						posture: sourceIntent.posture === "manual" ? "balanced" : sourceIntent.posture,
						maxCostUsd: input.costCeilingUsd,
						deadlineMs: null,
						requiredCapabilities: [...sourceIntent.requiredCapabilities],
						failover: "approved",
					};
		const request: DispatchRequest = {
			agentId: input.source.receipt.agentId,
			executionRole: "researcher",
			task: subtask.task,
			cwd: input.source.envelope.cwd,
			requestOrigin: "user",
			routingIntent,
			failover: "approved",
			...(input.authorization === "full-auto-policy" && sourceIntent.posture === "manual"
				? {
						target: input.source.receipt.targetId,
						model: input.source.receipt.wireModelId,
						node: input.source.receipt.node?.id ?? "local",
					}
				: {}),
		};
		proposals.push({
			...input.planAgentSelection({
				request,
				expectedResultContract: subtask.expectedResultContract,
				requestedAuthority: subtask.requestedAuthority,
				authorization: input.authorization,
			}),
			subtask,
			routingIntent,
		});
	}
	const priorCostCeiling = input.source.receipt.routingIntent.maxCostUsd;
	const effectiveCostCeiling =
		input.authorization === "full-auto-policy" && priorCostCeiling !== null
			? Math.min(input.costCeilingUsd, priorCostCeiling)
			: input.costCeilingUsd;
	const bindings: ScoutAgentBinding[] = proposals.map(({ subtask, agentSpec }) => ({
		subtaskId: subtask.id,
		spec: agentSpec,
	}));
	const requestedAuthorities = [
		...new Set(input.source.scout.proposedSubtasks.map((subtask) => subtask.requestedAuthority)),
	];
	const transition = compileScoutTransition({
		scout: input.source.scout,
		sourceReceiptDigest: input.source.receipt.integrity.digest,
		rootTask: input.source.receipt.task,
		bindings,
		authority: {
			basis: input.authorization,
			approvedAuthorities: input.authorization === "full-auto-policy" ? requestedAuthorities : [],
		},
		maxWorkers: 4,
	});
	if (transition.kind === "settled") throw new Error("dispatch: Scout phase unexpectedly settled during compilation");
	if (input.authorization === "full-auto-policy" && transition.kind !== "ready") {
		throw new Error("dispatch: full-auto policy does not grant every requested Scout authority");
	}
	const plan = transition.plan;
	const p95ByStep = new Map(
		proposals.map((proposal) => {
			const selected = proposal.decision.candidateEvaluations.find((entry) =>
				sameRouteIdentity(entry.candidate, proposal.decision.selected),
			);
			if (selected === undefined || selected.rejection !== null) {
				throw new Error(`dispatch: Scout step '${proposal.subtask.id}' has no admissible latency estimate`);
			}
			return [proposal.subtask.id, selected.estimate.p95EndToEndMs] as const;
		}),
	);
	const predictedDeadlineMs = Math.ceil(
		plan.waves.reduce(
			(total, wave) => total + Math.max(...wave.map((stepId) => p95ByStep.get(stepId) ?? Number.POSITIVE_INFINITY)),
			0,
		),
	);
	if (
		!Number.isFinite(predictedDeadlineMs) ||
		predictedDeadlineMs < 1 ||
		predictedDeadlineMs > MAX_SCOUT_PLAN_DEADLINE_MS
	) {
		throw new Error("dispatch: Scout continuation exceeds the finite whole-plan deadline ceiling");
	}
	const priorDeadlineMs = input.source.receipt.routingIntent.deadlineMs;
	if (input.authorization === "full-auto-policy" && priorDeadlineMs !== null && predictedDeadlineMs > priorDeadlineMs) {
		throw new Error("dispatch: full-auto Scout continuation exceeds the previously granted deadline");
	}
	const deadlineMs = Math.max(priorDeadlineMs ?? 0, predictedDeadlineMs);
	const requests: DispatchRequest[] = [];
	const resolutions: DispatchPlanTaskResolution[] = [];
	const tasks = plan.steps.map((step, index): ResolvedDispatchPlanArtifact["tasks"][number] => {
		const proposal = proposals.find((entry) => entry.subtask.id === step.id);
		if (proposal === undefined) throw new Error(`dispatch: Scout step '${step.id}' has no route proposal`);
		const selected = proposal.decision.selected;
		const selection: NonNullable<DispatchRequest["agentSelection"]> = {
			version: 1,
			mode: "auto",
			baselineAgentId: input.source.receipt.agentId,
			approvedAuthorities: [step.requestedAuthority],
			authorityBasis: input.authorization,
		};
		requests.push({
			agentId: selected.agentId,
			executionRole: selected.executionRole,
			task: step.task,
			cwd: input.source.envelope.cwd,
			requestOrigin: "user",
			agentSelection: selection,
			routingIntent: {
				...proposal.routingIntent,
				maxCostUsd: effectiveCostCeiling,
				deadlineMs,
				failover: "none",
			},
			failover: "none",
		});
		resolutions.push(proposal.resolution);
		return {
			agent: proposal.resolution.agentId,
			task: step.task,
			target: proposal.resolution.targetId,
			model: proposal.resolution.wireModelId,
			node: proposal.resolution.node.id,
			nodeKind: proposal.resolution.node.kind,
			...(proposal.resolution.node.host === undefined ? {} : { nodeHost: proposal.resolution.node.host }),
			routingIntent: {
				...proposal.routingIntent,
				maxCostUsd: effectiveCostCeiling,
				deadlineMs,
				failover: "none",
			},
			failover: "none",
			routeApproval: null,
			agentSelection: selection,
			stepId: step.id,
			dependencies: [...step.dependencies],
			executionRole: step.executionRole,
			expectedResultContract: step.expectedResultContract,
			authorityGrant: { requested: step.requestedAuthority, basis: input.authorization },
			agentDecision: proposal.decision,
			wave: plan.waves.findIndex((wave) => wave.includes(step.id)),
			role: "task",
			position: index + 1,
		};
	});
	const aggregateCost = resolutions.reduce((sum, resolution) => sum + resolution.costUpperBoundUsd, 0);
	if (!Number.isFinite(aggregateCost) || aggregateCost > effectiveCostCeiling) {
		throw new Error("dispatch: Scout continuation exceeds the scheduling cost ceiling");
	}
	return {
		artifact: {
			version: 3,
			topology: "fleet",
			source: {
				kind: "scout-transition",
				runId: input.source.receipt.runId,
				receiptDigest: input.source.receipt.integrity.digest,
				executionPlanHash: plan.hash,
			},
			maxWorkers: plan.maxWorkers,
			onFailure: plan.onFailure,
			tasks,
			costCeilingUsd: effectiveCostCeiling,
			deadlineMs,
		},
		requests,
		resolutions,
		executionPlan: plan,
	};
}
