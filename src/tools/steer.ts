import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

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
	if (!run) return { kind: "error", message: `steer: unknown run '${runId}'` };
	if (TERMINAL_STATUSES.has(run.status)) {
		return {
			kind: "error",
			message: `steer: run '${runId}' already finished (state=${run.outcome ?? run.status}); nothing to cancel`,
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
		name: ToolNames.Steer,
		description:
			"Control a running dispatched worker: action=guide injects a steering message at its next turn boundary, action=cancel terminates the run cleanly.",
		parameters: Type.Object({
			run_id: Type.String({ description: "Run id from dispatch output." }),
			action: stringEnum(["guide", "cancel"], "What to do."),
			message: Type.Optional(Type.String({ description: "action=guide: the steering message." })),
		}),
		baseActionClass: "dispatch",
		executionMode: "sequential",
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
