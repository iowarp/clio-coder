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
import type { RunOutcome, RunStatus } from "./types.js";

export interface RunTerminationEvidence {
	/** Process exit code; null when a native worker never reached a live session. */
	exitCode: number | null;
	/** Operator abort (SIGINT, /abort, batch cancel, drain). */
	abortedByOperator: boolean;
	/** The reconciler declared the worker dead (heartbeat) or stalled (ACP inactivity) and killed it. */
	stallKilled: boolean;
	/** Turn or run timeout was exceeded (ACP turn request timeout). */
	timedOut: boolean;
	/** Worker exited because workers.onPermission="fail" and a permission was required. */
	permissionFailure: boolean;
	/** Admission/budget/scope/cooldown rejection reason; non-null means policy denial. */
	policyDenied: string | null;
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
		return { outcome: "canceled", detail: evidence.abortedByOperator ? "operator abort" : "peer cancelled" };
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
