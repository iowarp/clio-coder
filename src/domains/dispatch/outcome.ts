/**
 * Single authority for mapping run-termination evidence to a RunOutcome.
 *
 * Every finalization path in the dispatch extension (native worker exit, ACP
 * delegation completion, watchdog kill, operator abort) builds a
 * RunTerminationEvidence record and calls resolveRunOutcome. No call site
 * assigns an outcome literal directly; retry policy, ledger status, and audit
 * records all derive from the resolved outcome.
 */

import type { RunBoundKind, RunTerminalReason } from "../../core/telemetry/enums.js";
import type { Payload } from "../../core/telemetry/schemas.js";
import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../worker/spec-contract.js";
import type { AbortReason } from "./contract.js";
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
	/** Worker exited because fleet.permissions.mode="fail" and a permission was required. */
	permissionFailure: boolean;
	/** Admission/budget/scope/cooldown rejection reason; non-null means policy denial. */
	policyDenied: string | null;
	/** Coordinator quality/verification gate rejected an otherwise successful completion. */
	qualityGateFailure?: boolean;
	/** ACP stopReason when the peer reported one. */
	stopReason: string | null;
	/** Cause recorded by `abort(runId, reason)`; absent for an operator cancel (#425). */
	abortCause?: AbortReason["cause"] | null;
	/** Control operation whose write could not reach the worker (#425). */
	channelFailure?: string | null;
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

export interface ResolvedTerminalReason {
	terminalReason: RunTerminalReason;
	boundKind?: RunBoundKind;
}

const BOUND_OUTCOME_CODES: Partial<Record<RunOutcomeCode, RunBoundKind>> = {
	worker_tool_call_cap_exhausted: "tools",
	loop_guard_tools_disabled_exhausted: "tools",
	worker_context_exhausted: "tokens",
	worker_output_cap_exhausted: "tokens",
	worker_turn_timeout: "time",
};

/**
 * How the worker loop ended, in the closed `run.settled` vocabulary. Host
 * verdicts applied after a normal ending (host verification, result-contract
 * conformance, no-work and blocked-mutation checks) leave the loop
 * `completed`; they live in outcome and outcomeCode (#425, #434).
 */
export function resolveRunTerminalReason(
	evidence: RunTerminationEvidence,
	outcomeCode: RunOutcomeCode | null,
): ResolvedTerminalReason {
	if (evidence.policyDenied !== null) return { terminalReason: "denied_by_policy" };
	if (evidence.stallKilled) return { terminalReason: "stalled" };
	// A peer that reports cancellation with no abort from this side canceled on its own (#434).
	if (!evidence.abortedByOperator && evidence.stopReason === "cancelled") return { terminalReason: "cancelled_by_peer" };
	if (evidence.abortedByOperator) {
		switch (evidence.abortCause) {
			case "timeout":
				return { terminalReason: "bound_reached", boundKind: "time" };
			case "budget":
				return { terminalReason: "bound_reached", boundKind: "cost" };
			case "capacity":
				return { terminalReason: "preempted" };
			case "parent":
				return { terminalReason: "cancelled_by_parent" };
			default:
				return { terminalReason: "cancelled_by_operator" };
		}
	}
	if (evidence.timedOut) return { terminalReason: "bound_reached", boundKind: "time" };
	if (evidence.exitCode === null) return { terminalReason: "spawn_error" };
	if (evidence.channelFailure) return { terminalReason: "channel_failure" };
	const bound = outcomeCode === null ? undefined : BOUND_OUTCOME_CODES[outcomeCode];
	if (bound !== undefined) return { terminalReason: "bound_reached", boundKind: bound };
	if (outcomeCode === "result_contract_exhausted") return { terminalReason: "contract_exhausted_after_repair" };
	if (outcomeCode === "worker_final_output_missing") return { terminalReason: "final_output_missing_no_repair" };
	if (evidence.permissionFailure || evidence.exitCode !== 0) return { terminalReason: "worker_failed" };
	return { terminalReason: "completed" };
}

/**
 * run.settled the host writes outside the worker's own finish: after a failed finalization, or at recovery for a run
 * whose host died. How the loop ended when it was resolved, else a failed worker; the calls only a receipt names
 * (#425, #434).
 */
export function hostRunSettledFacts(
	terminal: ResolvedTerminalReason | undefined,
	processExitCode: number | null = null,
	callIds: readonly string[] | null = null,
): Payload<"run.settled"> {
	return {
		terminalReason: terminal?.terminalReason ?? "worker_failed",
		callIds: callIds === null ? null : [...callIds],
		processExitCode,
		...(terminal?.boundKind ? { boundKind: terminal.boundKind } : {}),
		repairRounds: { kind: "unknown", reason: "not-observed" },
		frameType: null,
	};
}

/** A main-agent run has no worker loop evidence beyond its resolved outcome (#434). */
export function terminalReasonForOutcome(outcome: RunOutcome): RunTerminalReason {
	switch (outcome) {
		case "succeeded":
			return "completed";
		case "canceled":
			return "cancelled_by_operator";
		case "timed_out":
			return "bound_reached";
		case "stalled":
			return "stalled";
		case "denied_by_policy":
			return "denied_by_policy";
		case "spawn_failed":
			return "spawn_error";
		case "failed":
			return "worker_failed";
	}
}
