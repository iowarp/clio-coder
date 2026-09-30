import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareHookRegistration } from "./runtime.js";

/** A cached turn verdict or explicit proposal mode can close a plan without reading prose. */
export function createPlanCloseRegistration(deps: {
	canAsk: () => boolean;
	isPlan: () => boolean;
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
					armed = input.metadata?.turnMode === "proposal" || deps.isPlan();
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
