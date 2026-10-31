/**
 * A finished run's one persisted record (#434): the structural facts run.settled carries and the `run-result` object
 * it names, built together so the journal and the object never disagree.
 */

import type { EventPayload } from "../../core/telemetry/events.js";
import type { RunResultObject, RunSettled } from "../../core/telemetry/schemas.js";
import { RESULT_CONTRACT_REPAIR_LIMIT } from "../agents/result-contract.js";
import { runContextProvenance } from "../evidence/trust-status.js";
import { redactSecretString } from "../safety/redaction.js";
import type { ResolvedTerminalReason } from "./outcome.js";
import { labelledRunHashes } from "./receipt-hashes.js";
import type { RunUsageFacts } from "./run-call-usage.js";
import { unobservedRunUsageFacts } from "./run-call-usage.js";
import type { RunEnvelope, RunOutcome, RunResult } from "./types.js";

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

/** The settlement of a run whose worker finished, from what its finalization sealed (#434). */
export function settleFinishedRun(
	receipt: RunResult,
	input: {
		terminal: ResolvedTerminalReason;
		processExitCode: number | null;
		frameType: string | null;
		usage: RunUsageFacts | undefined;
	},
): RunSettlement {
	const usage = input.usage ?? unobservedRunUsageFacts();
	const host = receipt.hostVerification;
	return {
		facts: {
			version: 1,
			agentId: receipt.agentId,
			executionRole: receipt.executionRole,
			requestOrigin: receipt.requestOrigin ?? null,
			identity: identityOf(receipt),
			route: routeOf(receipt),
			node: nodeOf(receipt),
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
						})),
					}
				: null,
		},
	};
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
	return {
		facts: {
			version: 1,
			agentId: run.agentId,
			executionRole: run.executionRole,
			requestOrigin: run.requestOrigin ?? null,
			identity: identityOf(run),
			route: routeOf(run),
			node: nodeOf(run),
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
	};
}

/** The record the journal writes once the result object is stored. */
export function runSettledRecord(settlement: RunSettlement, result: RunSettled["result"]): EventPayload<"run.settled"> {
	return { ...settlement.facts, result };
}
