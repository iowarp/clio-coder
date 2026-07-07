/**
 * Wall-clock deadline for internal generator dispatches (the wiki documenter
 * and the bootstrap scout). These runs are unattended and headless: the worker
 * tool-call cap bounds tool spam and the heartbeat watchdog bounds silence,
 * but a model that keeps streaming tokens without finishing satisfies both
 * indefinitely, so the caller must bound wall-clock time itself. The deadline
 * aborts through the dispatch contract's timeout convention (AbortReason
 * cause "timeout") so the run's receipt records the real cause instead of an
 * operator cancel.
 */

import { GUARDRAIL_ENV_VARS, resolveGuardrail } from "../core/guardrails.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";

export interface InternalDispatchDeadline {
	/** True once the deadline fired and the run was aborted. */
	timedOut(): boolean;
	/** Cancel the pending timer; call from a finally block. */
	clear(): void;
	/** Operator-facing failure message for a fired deadline. */
	message(): string;
}

export function armInternalDispatchDeadline(
	dispatch: DispatchContract,
	runId: string,
	label: string,
	env: NodeJS.ProcessEnv = process.env,
): InternalDispatchDeadline {
	const timeoutMs = resolveGuardrail("internalDispatchTimeoutMs", env);
	let fired = false;
	const timer = setTimeout(() => {
		fired = true;
		try {
			dispatch.abort(runId, { cause: "timeout", detail: `${label} timed out after ${timeoutMs}ms` });
		} catch {
			// The run may have finalized between the timer firing and the abort.
		}
	}, timeoutMs);
	// The timer must hold the event loop: its firing is what aborts a runaway
	// run. Callers clear it in a finally block, so it never outlives the run.
	return {
		timedOut: () => fired,
		clear: () => clearTimeout(timer),
		message: () =>
			`${label} timed out after ${Math.round(timeoutMs / 1000)}s and was aborted. ` +
			`Raise guardrails.internalDispatchTimeoutMs (env ${GUARDRAIL_ENV_VARS.internalDispatchTimeoutMs}) for slower targets.`,
	};
}
