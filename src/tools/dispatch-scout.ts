/** Authenticated two-call Scout continuation protocol. */

import { parseScoutResult, resultContractSourceId, type ScoutResult } from "../domains/agents/result-contract.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import type { ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { executePlan } from "../domains/dispatch/execution-scheduler.js";
import { verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { normalizeYoloAuthorityBasis } from "../domains/dispatch/yolo-ids.js";
import type { ResolvedDispatchPlanArtifact } from "./dispatch-plan.js";

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

interface VerifiedScoutSource {
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

export function scoutPlanAuthorityGranted(
	artifact: ResolvedDispatchPlanArtifact,
	operatorApproved: boolean,
	yolo: boolean,
): boolean {
	return artifact.tasks.every(
		(task) =>
			task.authorityGrant !== null &&
			((task.authorityGrant.basis === "operator-plan-approval" && operatorApproved) ||
				(normalizeYoloAuthorityBasis(task.authorityGrant.basis) === "yolo-policy" && yolo)),
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
	const assignmentDeadlineAt = input.artifact.deadlineMs === null ? undefined : Date.now() + input.artifact.deadlineMs;
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
			async run(step, handoffs, reservation, ledger) {
				const bound = byStep.get(step.id);
				if (bound?.request === undefined) throw new Error(`Scout step '${step.id}' has no trusted request`);
				const request: DispatchRequest = {
					...bound.request,
					predecessorHandoffs: handoffs,
					reservation,
					...(assignmentDeadlineAt === undefined ? {} : { assignmentDeadlineAt }),
					...(ledger !== undefined ? { ledger } : {}),
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
			release: (ownerId) => input.dispatch.reservations?.release(ownerId),
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
