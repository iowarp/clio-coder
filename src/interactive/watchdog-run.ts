/**
 * The watchdog's run: one read-only verifier dispatch, one transcript notice.
 *
 * The middleware registration decides when to fire and what the turn changed;
 * this decides nothing. It dispatches through the ordinary path so admission,
 * the receipt, and the Fleet Runs island treat a watchdog run exactly as they
 * treat any other, reads the failed checks out of the `verifier-report`
 * contract, and hands the operator one line. A passing report produces nothing
 * at all.
 */

import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { parseVerifierResult } from "../domains/agents/index.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { type AgentRoleFactsResolver, requestExecutionRole } from "../domains/dispatch/execution-role.js";
import { WATCHDOG_TASK, type WatchdogTrigger, watchdogBriefing } from "../domains/middleware/index.js";
import { watchdogBlockersNotice } from "./bus-notices.js";

/** The builtin recipe the watchdog reviews with. */
export const WATCHDOG_AGENT_ID = "verifier";

export interface WatchdogRunDeps {
	dispatch: DispatchContract;
	bus?: SafeEventBus;
	getAgentRoleFacts?: AgentRoleFactsResolver;
	/** `watchdog.target` when the operator set one; the session's active target otherwise. */
	target?: string | undefined;
	/** One transcript line for the operator. Absent means the finding has nowhere to go and the run is skipped. */
	emitNotice?: (text: string) => void;
}

/**
 * Dispatch one watchdog review and report what it found.
 *
 * Resolves when the run has settled, whatever the outcome. A watchdog that
 * failed is not a turn that failed: the review is advisory, so a broken run
 * stays silent rather than raising an alarm about itself in the middle of the
 * operator's work.
 */
export async function runWatchdogReview(trigger: WatchdogTrigger, deps: WatchdogRunDeps): Promise<void> {
	if (!deps.emitNotice) return;
	const request: DispatchRequest = {
		agentId: WATCHDOG_AGENT_ID,
		task: WATCHDOG_TASK,
		briefing: watchdogBriefing(trigger),
		executionRole: requestExecutionRole({
			agentId: WATCHDOG_AGENT_ID,
			...(deps.getAgentRoleFacts ? { resolveFacts: deps.getAgentRoleFacts } : {}),
		}),
		requestOrigin: "internal",
		// Narrowed below whatever the session holds. A reviewer that could write
		// would be a second builder nobody admitted.
		autonomy: "read-only",
		...(deps.target ? { target: deps.target } : {}),
	};
	const progressBus = deps.dispatch.ownsProgressBus?.(deps.bus) === true ? undefined : deps.bus;
	try {
		const handle = await deps.dispatch.dispatch(request);
		for await (const event of handle.events) {
			const typed = event as { type?: string };
			if (!typed.type || typed.type === "heartbeat") continue;
			progressBus?.emit(BusChannels.DispatchProgress, { runId: handle.runId, agentId: WATCHDOG_AGENT_ID, event });
		}
		const receipt = await handle.finalPromise;
		const report = parseVerifierResult(receipt.output?.text ?? null);
		if (report === null) return;
		const notice = watchdogBlockersNotice(report.checks);
		if (notice === null) return;
		deps.emitNotice(notice.text);
	} catch {
		// An advisory review that could not run says nothing. The receipt, if one
		// was written at all, is in the dispatch board like every other run.
	}
}
