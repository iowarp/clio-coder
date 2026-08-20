import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { steerToolSurface } from "./steer-surface.js";

/**
 * The steer tool: control a running dispatched worker. action=guide injects a
 * steering message the worker sees at its next turn boundary (native workers
 * only; the dispatch contract's stdin channel). action=cancel terminates the
 * run cleanly; the receipt records the cancellation.
 */

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "stale", "dead"]);

export interface SteerToolDeps {
	dispatch: DispatchContract;
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

export function createSteerTool(deps: SteerToolDeps): ToolSpec {
	return {
		...steerToolSurface,
		async run(args): Promise<ToolResult> {
			const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
			if (runId.length === 0) return { kind: "error", message: "steer: missing run_id argument" };
			const action = typeof args.action === "string" ? args.action : "";
			if (action !== "guide" && action !== "cancel") {
				return { kind: "error", message: `steer: action must be guide or cancel; got '${action}'` };
			}
			if (action === "guide") {
				return guide(deps, runId, typeof args.message === "string" ? args.message.trim() : "");
			}
			return cancel(deps, runId);
		},
	};
}
