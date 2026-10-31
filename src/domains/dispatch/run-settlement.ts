/**
 * A finished run's one persisted record (#434): the structural facts run.settled carries and the `run-result` object
 * it names, built together so the journal and the object never disagree.
 */

import type { EventPayload } from "../../core/telemetry/events.js";
import type { RunResultObject, RunSettled } from "../../core/telemetry/schemas.js";
import { RESULT_CONTRACT_REPAIR_LIMIT } from "../agents/result-contract.js";
import { createRedactionTally, redactSecretsDeep } from "../evidence/redact.js";
import { runContextProvenance } from "../evidence/trust-status.js";
import { redactSecretString } from "../safety/redaction.js";
import { telemetryObjectRef } from "../telemetry/objects.js";
import { runSettledDigest } from "../telemetry/run-digest.js";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
} from "./budget-envelope.js";
import type { ResolvedTerminalReason } from "./outcome.js";
import { computeReceiptFindingsSummary } from "./receipt-findings.js";
import { labelledRunHashes, undeclaredReceiptHashes } from "./receipt-hashes.js";
import { routeConstraintValidity } from "./route-decision.js";
import { defaultRoutingIntent, type RoutingIntent } from "./routing-intent.js";
import type { RunUsageFacts } from "./run-call-usage.js";
import { unobservedRunUsageFacts } from "./run-call-usage.js";
import { runGatewayRoutingLabel, runResponseModelIdObservationLabel } from "./run-upstream.js";
import type { RunEnvelope, RunOutcome, RunResult, RunResultDraft } from "./types.js";

/** The facts and the object a run settles with; the journal adds the object's reference as `result`. */
export interface RunSettlement {
	facts: Omit<RunSettled, "result">;
	result: RunResultObject;
}

const DIAGNOSTIC_CHARS = 1024;

/** Diagnostic text as run.settled states it: redacted and clipped. The full text stays in the result object. */
function diagnostic(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value === "") return null;
	const redacted = redactSecretString(value);
	return redacted.length <= DIAGNOSTIC_CHARS ? redacted : `${redacted.slice(0, DIAGNOSTIC_CHARS - 1)}…`;
}

function repairRounds(terminal: ResolvedTerminalReason | undefined): RunSettled["repairRounds"] {
	return terminal?.terminalReason === "contract_exhausted_after_repair"
		? { kind: "measured", value: RESULT_CONTRACT_REPAIR_LIMIT, source: "local-count" }
		: { kind: "unknown", reason: "not-observed" };
}

function routeOf(
	run: Pick<RunEnvelope, "targetId" | "wireModelId" | "runtimeId" | "runtimeKind">,
): RunSettled["route"] {
	return {
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		runtimeId: run.runtimeId,
		runtimeKind: run.runtimeKind,
	};
}

function nodeOf(run: Pick<RunEnvelope, "node">): RunSettled["node"] {
	return run.node ? { id: run.node.id, kind: run.node.kind } : null;
}

function identityOf(run: Pick<RunEnvelope, "identity">): RunSettled["identity"] {
	return run.identity ? { host: run.identity.host, user: run.identity.user } : null;
}

function routingIntentOf(intent: RoutingIntent): RunSettled["routingIntent"] {
	return { ...intent, requiredCapabilities: [...intent.requiredCapabilities] };
}

function contextOf(
	run: Pick<RunResultDraft, "briefing" | "workerContext"> & Partial<Pick<RunResultDraft, "projectContext">>,
): RunSettled["context"] {
	return {
		briefingBytes: run.briefing?.bytes ?? null,
		worker: run.workerContext
			? {
					mode: run.workerContext.mode,
					estimatedTokens: run.workerContext.estimatedTokens,
					omittedMessages: run.workerContext.omittedMessages,
				}
			: null,
		project: run.projectContext
			? {
					tier: run.projectContext.tier,
					chars: run.projectContext.chars ?? null,
					sections: [...(run.projectContext.sections ?? [])],
				}
			: null,
	};
}

function escalationsOf(safety: RunResultDraft["safety"]): RunSettled["escalations"] {
	const decisions = safety?.decisions;
	if (decisions?.escalationRequested === undefined) return null;
	return {
		requested: decisions.escalationRequested,
		approved: decisions.escalationApproved ?? 0,
		denied: decisions.escalationDenied ?? 0,
		timedOut: decisions.escalationTimedOut ?? 0,
	};
}

/** The settlement of a run whose worker finished, from what its finalization sealed (#434). */
export function settleFinishedRun(
	receipt: RunResultDraft,
	input: {
		terminal: ResolvedTerminalReason;
		processExitCode: number | null;
		frameType: string | null;
		usage: RunUsageFacts | undefined;
	},
): RunSettlement {
	const usage = input.usage ?? unobservedRunUsageFacts();
	const host = receipt.hostVerification;
	return redactedSettlement({
		facts: {
			version: 1,
			agentId: receipt.agentId,
			executionRole: receipt.executionRole,
			requestOrigin: receipt.requestOrigin ?? null,
			identity: identityOf(receipt),
			route: routeOf(receipt),
			node: nodeOf(receipt),
			routeDecision: receipt.routeDecision
				? {
						decisionHash: receipt.routeDecision.decisionHash,
						mode: receipt.routeDecision.mode,
						durationMs: receipt.routeDecision.decisionDurationMs,
						constraintsValid: routeConstraintValidity(receipt.routeDecision).valid,
					}
				: null,
			routingIntent: routingIntentOf(receipt.routingIntent ?? defaultRoutingIntent({})),
			startedAt: receipt.startedAt,
			endedAt: receipt.endedAt,
			outcome: receipt.outcome,
			outcomeCode: receipt.outcomeCode ?? null,
			exitCode: receipt.exitCode,
			outcomeDetail: diagnostic(receipt.outcomeDetail),
			failureMessage: diagnostic(receipt.failureMessage),
			terminalReason: input.terminal.terminalReason,
			callIds: receipt.callIds ?? null,
			processExitCode: input.processExitCode,
			...(input.terminal.boundKind ? { boundKind: input.terminal.boundKind } : {}),
			repairRounds: repairRounds(input.terminal),
			frameType: input.frameType,
			...usage,
			toolCalls: receipt.toolCalls,
			tools: receipt.toolStats.slice(0, 256).map((stat) => ({
				tool: stat.tool,
				calls: stat.count,
				ok: stat.ok,
				errors: stat.errors,
				blocked: stat.blocked,
			})),
			skills: (receipt.skillActivations ?? [])
				.slice(0, 256)
				.map((skill) => ({ name: skill.name, requestSource: skill.requestSource ?? null })),
			toolActivity: receipt.toolActivity ? { ...receipt.toolActivity } : null,
			capabilityMismatch: receipt.capabilityMismatch
				? {
						agentId: receipt.capabilityMismatch.agentId,
						capabilityClass: receipt.capabilityMismatch.capabilityClass,
						taskType: receipt.capabilityMismatch.taskType,
						suggestedAgentId: receipt.capabilityMismatch.suggestedAgentId,
					}
				: null,
			budget: receipt.budget
				? {
						policy: diagnostic(formatBudgetPolicy(receipt.budget)) ?? "",
						requested: diagnostic(formatBudgetRequest(receipt.budget)) ?? "",
						effective: diagnostic(formatEffectiveBudget(receipt.budget)) ?? "",
						reasons: diagnostic(formatBudgetReasons(receipt.budget)) ?? "",
					}
				: null,
			context: contextOf(receipt),
			upstream: {
				responseModelIds: diagnostic(runResponseModelIdObservationLabel(receipt)),
				gatewayRoutes: diagnostic(runGatewayRoutingLabel(receipt)),
			},
			blockedAttempts: (receipt.safety?.blockedAttempts ?? []).slice(0, 64).map((attempt) => ({
				tool: attempt.tool,
				actionClass: attempt.actionClass ?? null,
				ruleId: attempt.ruleId ?? null,
				reasonCode: attempt.reasonCode ?? null,
			})),
			escalations: escalationsOf(receipt.safety),
			flowRestrictions: receipt.safety?.flowRestrictions
				? {
						version: 1,
						restrictions: receipt.safety.flowRestrictions.restrictions.map((entry) => ({
							ruleId: entry.ruleId,
							policyHash: entry.policyHash,
							sourceRef: entry.sourceRef,
							recipients: [...entry.recipients],
						})),
						...(receipt.safety.flowRestrictions.advisory ? { advisory: [...receipt.safety.flowRestrictions.advisory] } : {}),
					}
				: null,
			toolGovernance: receipt.delegation?.toolGovernance ?? null,
			verification: { state: receipt.verification.state, basis: receipt.verification.basis },
			quality: {
				typedValidations: receipt.quality.typedValidations.map((fact) => ({ ...fact })),
				responseSchema: { ...receipt.quality.responseSchema },
				resultContract: receipt.quality.resultContract ? { ...receipt.quality.resultContract } : null,
			},
			validationGrounding: receipt.validationGrounding
				? { ...receipt.validationGrounding, ungrounded: [...receipt.validationGrounding.ungrounded] }
				: null,
			findings: receipt.findingsSummary
				? {
						tags: [...receipt.findingsSummary.tags],
						firstPassSuccess: receipt.findingsSummary.firstPassSuccess,
						findingCount: receipt.findingsSummary.findingCount,
					}
				: null,
			worktree: receipt.worktree
				? { apply: receipt.worktree.apply, applied: receipt.worktree.applied, snapshot: receipt.worktree.snapshot ?? null }
				: null,
			hostVerification: host
				? {
						status: host.status,
						strategy: host.strategy ?? "single",
						checks: host.checks.length,
						failed: host.checks.filter((check) => check.exitCode !== 0).length,
						failedOnBase: host.checks.filter((check) => check.exitCode !== 0 && check.baseComparison?.status === "failed")
							.length,
					}
				: null,
			contextProvenance: runContextProvenance(receipt),
			hashes: labelledRunHashes(receipt, receipt.agentId),
		},
		result: {
			version: 1,
			output: receipt.output
				? {
						state: receipt.output.state,
						text: receipt.output.text,
						bytes: receipt.output.bytes,
						truncated: receipt.output.truncated,
						...(receipt.output.structured !== undefined ? { structured: receipt.output.structured } : {}),
					}
				: null,
			failureMessage: receipt.failureMessage ?? null,
			outcomeDetail: receipt.outcomeDetail ?? null,
			worktree: receipt.worktree
				? {
						path: receipt.worktree.path,
						branch: receipt.worktree.branch,
						diffHash: receipt.worktree.diffHash,
						...(receipt.worktree.changedPaths !== undefined ? { changedPaths: [...receipt.worktree.changedPaths] } : {}),
						...(receipt.worktree.commit !== undefined ? { commit: receipt.worktree.commit } : {}),
						...(receipt.worktree.reason !== undefined ? { reason: receipt.worktree.reason } : {}),
						...(receipt.worktree.detail !== undefined ? { detail: receipt.worktree.detail } : {}),
					}
				: null,
			checkoutChanges: receipt.checkoutChanges
				? { ...receipt.checkoutChanges, changedPaths: [...receipt.checkoutChanges.changedPaths] }
				: null,
			hostVerification: host
				? {
						reason: host.reason ?? null,
						checks: host.checks.map((check) => ({
							check: check.check,
							argv: [...check.argv],
							cwd: check.cwd,
							exitCode: check.exitCode,
							durationMs: check.durationMs,
							memo: check.memo,
							outputTail: check.outputTail,
							evidenceRunId: check.evidenceRunId ?? null,
							baseComparison: check.baseComparison ? { ...check.baseComparison } : null,
						})),
					}
				: null,
		},
	});
}

/**
 * The settlement the host writes for a run whose own finish never sealed: a finalization that failed, or recovery for
 * a run whose host died. How the loop ended when it was resolved, else a failed worker; nothing it did not see (#425).
 */
export function settleUnfinishedRun(
	run: RunEnvelope,
	input: {
		terminal: ResolvedTerminalReason | undefined;
		outcome: RunOutcome;
		detail: string;
		endedAt: string;
		processExitCode: number | null;
	},
): RunSettlement {
	return redactedSettlement({
		facts: {
			version: 1,
			agentId: run.agentId,
			executionRole: run.executionRole,
			requestOrigin: run.requestOrigin ?? null,
			identity: identityOf(run),
			route: routeOf(run),
			node: nodeOf(run),
			routeDecision: null,
			routingIntent: routingIntentOf(defaultRoutingIntent({})),
			startedAt: run.startedAt,
			endedAt: input.endedAt,
			outcome: input.outcome,
			outcomeCode: null,
			exitCode: run.exitCode ?? input.processExitCode,
			outcomeDetail: diagnostic(input.detail),
			failureMessage: null,
			terminalReason: input.terminal?.terminalReason ?? "worker_failed",
			callIds: null,
			processExitCode: input.processExitCode,
			...(input.terminal?.boundKind ? { boundKind: input.terminal.boundKind } : {}),
			repairRounds: repairRounds(input.terminal),
			frameType: null,
			...unobservedRunUsageFacts(),
			toolCalls: 0,
			tools: [],
			skills: [],
			toolActivity: null,
			capabilityMismatch: null,
			budget: null,
			context: contextOf(run),
			upstream: { responseModelIds: null, gatewayRoutes: null },
			blockedAttempts: [],
			escalations: null,
			flowRestrictions: null,
			toolGovernance: null,
			verification: { state: "unknown", basis: "receipt-unavailable" },
			quality: null,
			validationGrounding: null,
			findings: null,
			worktree: null,
			hostVerification: null,
			contextProvenance: runContextProvenance(run),
			hashes: [],
		},
		result: {
			version: 1,
			output: null,
			failureMessage: null,
			outcomeDetail: input.detail,
			worktree: null,
			checkoutChanges: null,
			hostVerification: null,
		},
	});
}

/** The record the journal writes once the result object is stored. */
export function runSettledRecord(settlement: RunSettlement, result: RunSettled["result"]): EventPayload<"run.settled"> {
	return { ...settlement.facts, result };
}

/**
 * The journal deep-redacts every record it writes. Settling facts that already passed the same redaction makes that
 * pass leave them unchanged, so the digest a producer computes names the payload the journal persists (#434).
 */
function redactedSettlement(settlement: RunSettlement): RunSettlement {
	return { ...settlement, facts: redactSecretsDeep(settlement.facts, createRedactionTally()) };
}

/** A finished run as dispatch hands it to its caller, and the settlement its journal records from the same facts. */
export interface FinishedRunResult {
	result: RunResult;
	settlement: RunSettlement;
}

/**
 * The one function that finishes a run (#434): it seals the findings summary onto the result, builds the settlement
 * run.settled records from it, and names the result by the digest of that record, so the value dispatch hands its
 * caller and the record its journal keeps never disagree. `row` is the run ledger row as the terminal patch leaves it.
 */
export function finishRunResult(
	draft: RunResultDraft,
	row: RunEnvelope,
	input: {
		terminal: ResolvedTerminalReason;
		processExitCode: number | null;
		frameType: string | null;
		usage: RunUsageFacts | undefined;
	},
): FinishedRunResult {
	if (draft.routingIntent === undefined) throw new Error(`run ${draft.runId} has no routing intent`);
	// R7: a hash without a declared function, canonicalization, subject and label is never settled (#434).
	const undeclared = undeclaredReceiptHashes(draft, draft.agentId);
	if (undeclared.length > 0) throw new Error(`run ${draft.runId} carries undeclared hashes ${undeclared.join(", ")}`);
	const sealed: RunResultDraft =
		draft.findingsSummary === undefined
			? { ...draft, findingsSummary: computeReceiptFindingsSummary(draft, row) }
			: draft;
	const settlement = settleFinishedRun(sealed, input);
	const record = runSettledRecord(settlement, telemetryObjectRef("run-result", settlement.result));
	return {
		result: { ...sealed, routingIntent: draft.routingIntent, digest: runSettledDigest(record) },
		settlement,
	};
}
