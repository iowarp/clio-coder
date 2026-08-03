/**
 * Single authority for mapping run-termination evidence to a RunOutcome.
 *
 * Every finalization path in the dispatch extension (native worker exit, ACP
 * delegation completion, watchdog kill, operator abort) builds a
 * RunTerminationEvidence record and calls resolveRunOutcome. No call site
 * assigns an outcome literal directly; retry policy, ledger status, and audit
 * records all derive from the resolved outcome.
 */

import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../worker/spec-contract.js";
import type { RunOutcome, RunOutcomeCode, RunStatus } from "./types.js";

export interface RunTerminationEvidence {
	/** Process exit code; null when a native worker never reached a live session. */
	exitCode: number | null;
	/** Operator abort (SIGINT, /abort, batch cancel, drain). */
	abortedByOperator: boolean;
	/**
	 * Cause detail when the abort was not an operator cancel (e.g. a dispatch
	 * `timeout_ms` kill). Names the timeout on the receipt so it stays
	 * distinguishable from an operator abort; the outcome remains `canceled`.
	 */
	abortDetail?: string | null;
	/** The reconciler declared the worker dead (heartbeat) or stalled (ACP inactivity) and killed it. */
	stallKilled: boolean;
	/** Turn or run timeout was exceeded (ACP turn request timeout). */
	timedOut: boolean;
	/** Worker exited because workers.onPermission="fail" and a permission was required. */
	permissionFailure: boolean;
	/** Admission/budget/scope/cooldown rejection reason; non-null means policy denial. */
	policyDenied: string | null;
	/** Coordinator quality/verification gate rejected an otherwise successful completion. */
	qualityGateFailure?: boolean;
	/** ACP stopReason when the peer reported one. */
	stopReason: string | null;
}

export interface ResolvedOutcome {
	outcome: RunOutcome;
	detail: string | null;
}

export function resolveRunOutcome(evidence: RunTerminationEvidence): ResolvedOutcome {
	if (evidence.policyDenied !== null) {
		return { outcome: "denied_by_policy", detail: evidence.policyDenied };
	}
	// A reconciler kill ranks above cancellation evidence: terminating a
	// stalled peer goes through the cancel/close path, which must not launder
	// a stall into an operator abort.
	if (evidence.stallKilled) {
		return { outcome: "stalled", detail: "no worker activity within the stall window" };
	}
	if (evidence.abortedByOperator || evidence.stopReason === "cancelled") {
		const detail = evidence.abortedByOperator ? (evidence.abortDetail ?? "operator abort") : "peer cancelled";
		return { outcome: "canceled", detail };
	}
	if (evidence.timedOut) {
		return { outcome: "timed_out", detail: "turn timeout exceeded" };
	}
	if (evidence.exitCode === null) {
		return { outcome: "spawn_failed", detail: "process never reached a live session" };
	}
	if (evidence.permissionFailure || evidence.exitCode === WORKER_EXIT_PERMISSION_REQUIRED) {
		return { outcome: "failed", detail: "permission_required" };
	}
	if (evidence.exitCode === 0) {
		return { outcome: "succeeded", detail: null };
	}
	const stopSuffix = evidence.stopReason !== null ? ` (stopReason=${evidence.stopReason})` : "";
	return { outcome: "failed", detail: `exit code ${evidence.exitCode}${stopSuffix}` };
}

/**
 * Backward-compatible ledger status for a resolved outcome. RunStatus predates
 * the taxonomy and is what pre-sprint receipts seal over, so the mapping is
 * fixed: it must keep producing the statuses the old finalizer produced.
 */
export function runStatusForOutcome(outcome: RunOutcome): RunStatus {
	switch (outcome) {
		case "succeeded":
			return "completed";
		case "canceled":
			return "interrupted";
		case "stalled":
			return "dead";
		default:
			return "failed";
	}
}

/**
 * Whether a declared result contract was ever due for this attempt.
 *
 * A postcondition is only an applicable correctness check once the run reached
 * the point of producing a terminal result. Two termination shapes qualify:
 * the worker finished its own execution normally, or the worker itself
 * validated a terminal result and exhausted its bounded repair rounds.
 *
 * Everything else left the contract unevaluated: an operator abort, a crash
 * before the first token, a target that could not load the model, a stall
 * kill, and an engine loop-guard abort. Validating a `null` output in those
 * cases manufactures a `fail` out of infrastructure noise, which then enters
 * route history as correctness evidence about a model that never ran. Measured
 * against real history, that inflated the Scout failure count by 8 of 16.
 */
export function resultContractWasDue(outcome: RunOutcome, outcomeCode: RunOutcomeCode | null): boolean {
	return outcome === "succeeded" || outcomeCode === "result_contract_exhausted";
}
