import { ToolNames } from "../../core/tool-names.js";
import { dispatchMutatedParentWorkspace } from "../dispatch/workspace-mutation.js";
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
	let changed = false;
	let asked = false;
	let closed = false;
	return {
		id: "nudge.plan-close",
		description: "close an unapproved plan through ask_user once",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input) {
			if (input.hook === "turn_start") {
				armed = false;
				changed = false;
				asked = false;
				closed = false;
				if (input.metadata?.requestContinuation !== true && deps.canAsk()) {
					armed =
						input.metadata?.turnMode === "proposal" ||
						(deps.isPlan() ?? (typeof input.text === "string" && PLAN_REQUEST.test(input.text)));
				}
				return [];
			}
			if (!armed) return [];
			if (input.hook === "after_tool") {
				// A plan request carried out through dispatch is already done. The same receipt
				// reading the loop guard uses separates a worker that moved the parent's files
				// from a read-only scout, which leaves the plan still to be approved.
				if (
					input.toolName === ToolNames.Edit ||
					input.toolName === ToolNames.Write ||
					(input.toolName === ToolNames.Dispatch && dispatchMutatedParentWorkspace(input.toolResultDetails))
				)
					changed = true;
				if (input.toolName === ToolNames.AskUser) {
					asked = true;
					const questions = input.toolArgs?.questions;
					if (Array.isArray(questions)) {
						closed ||= questions.some(
							(question) =>
								question !== null &&
								typeof question === "object" &&
								"question" in question &&
								typeof question.question === "string" &&
								/^carry out this plan\?/iu.test(question.question.trim()),
						);
					}
				}
				return [];
			}
			if (input.hook !== "turn_end") return [];
			armed = false;
			if (changed || closed || (asked && !input.text?.trim()) || !deps.canAsk() || input.metadata?.stopReason !== "stop")
				return [];
			return [
				{
					kind: "request_continuation",
					message:
						'Close this plan with ask_user "Carry out this plan?". Put any open choices in the options, with one-line descriptions and the recommended option first, and end with "Revise the plan first" so the operator can decline. Do not restate the plan.',
				},
			];
		},
	};
}
