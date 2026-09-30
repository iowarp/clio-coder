import type { DispatchContract, WorkerGrantView } from "../domains/dispatch/contract.js";

/**
 * How a worker permission request routed to the main agent reads in dispatch
 * and monitor output (Phase D): what it asks, who may decide, and the exact
 * steer call that answers it. Only the bounded preview appears here.
 */
export function grantRequestLines(view: WorkerGrantView): string[] {
	const remainingMs = Date.parse(view.deadlineAt) - Date.now();
	const expires = Number.isFinite(remainingMs) ? `expires in ${Math.max(0, Math.round(remainingMs / 1000))}s` : "";
	const authority =
		view.approvalAuthority === "main"
			? view.forwardedByMain === true
				? "with the operator at your request; you may still deny"
				: "you may decide"
			: "operator authority: only the operator can approve; you may deny";
	return [
		`permission request ${view.requestId} from run ${view.runId} (agent ${view.agentId}, attempt ${view.attempt}): ${view.summary}${view.target !== undefined ? ` target: ${view.target}` : ""}`,
		`  ${authority}${expires.length > 0 ? `; ${expires}` : ""}. Decide with steer(run_id="${view.runId}", action="approve" or "deny", request_id="${view.requestId}"); approving runs this one call once, and an identical later call asks again.`,
	];
}

/** Pending requests the main agent itself must answer: main authority, not already with the operator. */
export function requestsAwaitingMain(
	dispatch: Pick<DispatchContract, "grants">,
	runIds: ReadonlyArray<string>,
): WorkerGrantView[] {
	const grants = dispatch.grants;
	if (grants === undefined || runIds.length === 0) return [];
	const ids = new Set(runIds);
	return grants
		.list({ pendingOnly: true })
		.filter(
			(view) =>
				view.approvalAuthority === "main" &&
				view.forwardedByMain !== true &&
				(ids.has(view.runId) || ids.has(view.rootRunId)),
		);
}

/** Every pending request of these runs, whoever decides it. */
export function pendingRequestsFor(
	dispatch: Pick<DispatchContract, "grants">,
	runIds: ReadonlyArray<string>,
): WorkerGrantView[] {
	const grants = dispatch.grants;
	if (grants === undefined || runIds.length === 0) return [];
	const ids = new Set(runIds);
	return grants.list({ pendingOnly: true }).filter((view) => ids.has(view.runId) || ids.has(view.rootRunId));
}
