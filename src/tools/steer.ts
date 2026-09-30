import type { DispatchContract } from "../domains/dispatch/contract.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { steerToolSurface } from "./steer-surface.js";

/**
 * The steer tool: control a running dispatched worker. action=guide injects a
 * steering message the worker sees at its next turn boundary (native workers
 * only; the dispatch contract's stdin channel). action=cancel terminates the
 * run cleanly; the receipt records the cancellation. action=approve and
 * action=deny answer one worker permission request routed to the main agent
 * (Phase D): the request id is looked up in the dispatch domain's grant
 * broker, never trusted from the arguments, and approval is admitted there as
 * the main agent's own call.
 *
 * Both act only on runs this session dispatched. The run ledger and the
 * assignment store are machine-wide, and a cancel aimed at another process's
 * assignment reached nothing (abort only touches this process's workers) while
 * the tool reported "cancellation signalled".
 */

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "stale", "dead"]);

export interface SteerToolDeps {
	dispatch: DispatchContract;
	/** The main agent's effective autonomy; approval below yolo goes to the operator or is denied. */
	getAutonomy?: () => AutonomyLevel;
}

/** The refusal for a run or assignment this session did not dispatch, or null when it did. */
function foreignRunError(
	deps: SteerToolDeps,
	runId: string,
	options: ToolInvokeOptions | undefined,
): ToolResult | null {
	const run = deps.dispatch.getRun(runId);
	const assignment = deps.dispatch.assignments?.getStored(run?.lineage?.rootRunId ?? runId) ?? null;
	const owned = run ?? (assignment === null ? null : deps.dispatch.getRun(assignment.assignmentId));
	if (owned !== null) {
		if (dispatchOwnership(dispatchOwnerOf(deps.dispatch, options?.sessionId)).ownsRun(owned)) return null;
		return {
			kind: "error",
			message: `steer: run '${runId}' belongs to another session; only the session that dispatched it can steer or cancel it`,
		};
	}
	const holder = assignment?.status === "running" ? assignment.processOwner : undefined;
	if (holder !== undefined && holder.pid !== process.pid) {
		return {
			kind: "error",
			message: `steer: assignment '${runId}' is running in another Clio process (pid ${holder.pid}); steer or cancel it from that session`,
		};
	}
	return null;
}

function guide(deps: SteerToolDeps, runId: string, message: string): ToolResult {
	if (message.length === 0) {
		return { kind: "error", message: "steer: action=guide requires a non-empty message" };
	}
	try {
		deps.dispatch.steer(runId, message);
	} catch (err) {
		return { kind: "error", message: err instanceof Error ? err.message : String(err) };
	}
	return {
		kind: "ok",
		output: `steer queued for run ${runId} (${message.length} chars); the worker sees it as a user message at its next turn boundary.`,
		details: { action: "guide", runId, chars: message.length },
	};
}

function cancel(deps: SteerToolDeps, runId: string): ToolResult {
	const run = deps.dispatch.getRun(runId);
	const rootRunId = run?.lineage?.rootRunId ?? runId;
	const assignment = deps.dispatch.assignments?.getStored(rootRunId) ?? null;
	if (!run && !assignment) return { kind: "error", message: `steer: unknown run or assignment '${runId}'` };
	if (assignment?.status === "running") {
		deps.dispatch.abort(rootRunId);
		return {
			kind: "ok",
			output: `cancellation signalled for assignment ${rootRunId}; its current attempt will finalize and no future attempt will start.`,
			details: { action: "cancel", runId: rootRunId, assignmentId: rootRunId },
		};
	}
	if (!run || TERMINAL_STATUSES.has(run.status)) {
		return {
			kind: "error",
			message: `steer: run or assignment '${runId}' already finished (state=${assignment?.status ?? run?.outcome ?? run?.status ?? "unknown"}); nothing to cancel`,
		};
	}
	deps.dispatch.abort(runId);
	return {
		kind: "ok",
		output: `cancellation signalled for run ${runId}; the run finalizes with outcome=canceled and its receipt records the cancellation.`,
		details: { action: "cancel", runId },
	};
}

async function decideGrant(
	deps: SteerToolDeps,
	runId: string,
	action: "approve" | "deny",
	requestId: string,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	const grants = deps.dispatch.grants;
	if (grants === undefined) {
		return { kind: "error", message: "steer: worker permission requests are not available in this context" };
	}
	if (requestId.length === 0) {
		return { kind: "error", message: `steer: action=${action} requires request_id from the dispatch or monitor output` };
	}
	const outcome = await grants.decideAsMain({
		requestId,
		runId,
		decision: action,
		sessionId: options?.sessionId ?? null,
		autonomy: deps.getAutonomy?.() ?? "default",
		...(options?.turnConstraints !== undefined ? { turnConstraints: options.turnConstraints } : {}),
		...(options?.signal !== undefined ? { signal: options.signal } : {}),
	});
	if (!outcome.ok) {
		return {
			kind: "error",
			message: `steer: ${outcome.message}`,
			details: { action, runId, requestId, ...(outcome.view !== undefined ? { request: { ...outcome.view } } : {}) },
		};
	}
	return {
		kind: "ok",
		output: `${outcome.message}. Follow the run with monitor(mode="wait", run_id="${runId}").`,
		details: {
			action,
			runId,
			requestId,
			decision: outcome.decision,
			decidedBy: outcome.decidedBy,
			request: { ...outcome.view },
		},
	};
}

export function createSteerTool(deps: SteerToolDeps): ToolSpec {
	return {
		...steerToolSurface,
		async run(args, options): Promise<ToolResult> {
			const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
			if (runId.length === 0) return { kind: "error", message: "steer: missing run_id argument" };
			const action = typeof args.action === "string" ? args.action : "";
			if (action !== "guide" && action !== "cancel" && action !== "approve" && action !== "deny") {
				return {
					kind: "error",
					message: `steer: action must be guide or cancel; got '${action}' (approve and deny answer a worker permission request with request_id)`,
				};
			}
			const foreign = foreignRunError(deps, runId, options);
			if (foreign !== null) return foreign;
			if (action === "approve" || action === "deny") {
				return decideGrant(deps, runId, action, typeof args.request_id === "string" ? args.request_id.trim() : "", options);
			}
			if (action === "guide") {
				return guide(deps, runId, typeof args.message === "string" ? args.message.trim() : "");
			}
			return cancel(deps, runId);
		},
	};
}
