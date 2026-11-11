import { resolve } from "node:path";
import { Type } from "typebox";
import { detectClioCoderRepo } from "../core/clio-repo.js";
import { RESTART_CONTINUATION_MAX } from "../core/restart-intent.js";
import { requestModelRestart, restartRequestUnavailable } from "../core/restart-request.js";
import { runningPackageRoot } from "../core/running-build.js";
import { ToolNames } from "../core/tool-names.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { ToolConfirmation, ToolSpec } from "./registry.js";

/** Rule id of the approval card a model-requested restart opens. */
export const RESTART_SESSION_RULE_ID = "restart-session";

export interface RestartSessionDeps {
	getCwd(): string;
	getAutonomy?: () => AutonomyLevel;
}

/** Why a restart cannot be requested from `cwd`; null when the workspace is the tree this Clio runs from. */
export function restartSessionWorkspaceRefusal(cwd: string, packageRoot = runningPackageRoot()): string | null {
	const repo = detectClioCoderRepo(cwd).repoRoot;
	if (!repo) return "the workspace is not Clio Coder's source tree";
	if (resolve(repo) !== resolve(packageRoot)) return "this session does not run from the workspace's build";
	return null;
}

/**
 * A restart onto the build on disk, requested by the model after it rebuilt
 * the tree this session runs from. It never restarts mid-turn: approval
 * records the request and the interactive host runs it, through `/restart
 * <continuation>`, once the turn ends and nothing is busy. Only the operator
 * approves it; at yolo nobody would, so it is refused back to the model.
 */
export function createRestartSessionTool(deps: RestartSessionDeps): ToolSpec {
	const refusal = (): string | null => {
		const autonomy = deps.getAutonomy?.();
		if (autonomy === "yolo") return "at autonomy yolo nobody approves a restart; ask the operator to type /restart";
		if (autonomy !== undefined && autonomy !== "default") return "the session autonomy is unknown";
		return restartSessionWorkspaceRefusal(deps.getCwd()) ?? restartRequestUnavailable();
	};
	const continuationOf = (args: Record<string, unknown>): string =>
		(typeof args.continuation === "string" ? args.continuation.trim() : "").slice(0, RESTART_CONTINUATION_MAX);
	return {
		name: ToolNames.RestartSession,
		description:
			"After rebuilding the tree this session runs from, request a restart onto the new build with what to do next. The operator approves it on a card; the session restarts when this turn ends, resumes with its history, and receives the continuation as its next message. Refused at yolo, outside Clio's own source tree, and when the session runs from another build.",
		placement: "gateway",
		parameters: Type.Object({
			continuation: Type.String({ description: "What the restarted session does next" }),
			reason: Type.Optional(Type.String({ description: "Why a restart is needed" })),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		confirmationFor(args): ToolConfirmation | undefined {
			if (refusal() !== null || continuationOf(args) === "") return undefined;
			const reason = typeof args.reason === "string" && args.reason.trim() ? `\nReason: ${args.reason.trim()}` : "";
			return {
				ruleId: RESTART_SESSION_RULE_ID,
				detail: `Restart Clio on the new build and continue: ${continuationOf(args)}${reason}`,
				hints: [],
			};
		},
		async run(args) {
			const blocked = refusal();
			if (blocked !== null) return { kind: "error", message: `restart_session refused: ${blocked}.` };
			const continuation = continuationOf(args);
			if (continuation === "") return { kind: "error", message: "restart_session requires a continuation" };
			requestModelRestart(continuation);
			return {
				kind: "ok",
				output:
					"Restart approved. It runs when this turn ends and nothing else is busy; end the turn now. The restarted session receives the continuation as its next message.",
			};
		},
	};
}
