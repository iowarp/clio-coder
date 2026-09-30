import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareHookRegistration } from "./runtime.js";

/**
 * The operator asked for a plan in words. Only the operator's own request is
 * read, never the model's reply. A match that was not a plan request costs one
 * "Carry out this plan?" card on a turn that already changed nothing.
 */
const PLAN_REQUEST = /\bplan(?:s|ning)?\b/iu;

/**
 * Close a requested plan through ask_user once. Proposal mode arms it; so does
 * the turn verdict when System One is fitted. Without a verdict, the default
 * install's case, the operator's request naming a plan arms it: the prompt
 * contract alone closed 2 of 5 identical plan requests on a local model in the
 * v0.6.0 flywheel, and the verdict-only arming never ran outside System One.
 */
export function createPlanCloseRegistration(deps: {
	canAsk: () => boolean;
	/** The fitted verdict's reading, or undefined when System One gave none. */
	isPlan: () => boolean | undefined;
}): MiddlewareHookRegistration {
	let armed = false;
	let askedOrChanged = false;
	return {
		id: "nudge.plan-close",
		description: "close an unapproved plan through ask_user once",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input) {
			if (input.hook === "turn_start") {
				armed = false;
				askedOrChanged = false;
				if (input.metadata?.requestContinuation !== true && deps.canAsk()) {
					armed =
						input.metadata?.turnMode === "proposal" ||
						(deps.isPlan() ?? (typeof input.text === "string" && PLAN_REQUEST.test(input.text)));
				}
				return [];
			}
			if (!armed) return [];
			if (input.hook === "after_tool") {
				if (input.toolName === ToolNames.AskUser || input.toolName === ToolNames.Edit || input.toolName === ToolNames.Write)
					askedOrChanged = true;
				return [];
			}
			if (input.hook !== "turn_end") return [];
			armed = false;
			if (askedOrChanged || !deps.canAsk() || input.metadata?.stopReason !== "stop") return [];
			return [
				{
					kind: "request_continuation",
					message:
						'Close this plan with ask_user "Carry out this plan?". Put any open choices in the options, with one-line descriptions and the recommended option first. Do not restate the plan.',
				},
			];
		},
	};
}
