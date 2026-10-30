import { isPlanOnlyRequest } from "../../core/plan-request.js";
import { ToolNames } from "../../core/tool-names.js";
import { dispatchMutatedParentWorkspace } from "../dispatch/workspace-mutation.js";
import type { MiddlewareHookRegistration } from "./runtime.js";

// Pasted documents are evidence, not operator intent (#431).
const PLAN_REQUEST = /\bplan(?:s|ning)?\b/iu;
const DISCUSSION_REQUEST =
	/^\s*(?:(?:let['’]s|let us|please|(?:can|could|would) (?:we|you)|i want to)\s+)?discuss\b|^\s*(?:(?:this is|for|just|only|continue the)\s+)?discussion\b|^\s*.{0,100}\b(?:me|i(?:['’]m| am))\s+sharing\b/iu;
const LONG_MESSAGE_CHARS = 4_000;
// A full 128K request is too expensive to repeat solely for a closing card (#431).
const PLAN_CLOSE_CONTEXT_THRESHOLD = 128_000;
// Match the exploration advisory's short follow-up scope; a new task drops the close (#431).
const PLAN_CLOSE_REMINDER_IDLE_MS = 5 * 60_000;
const PLAN_CLOSE_FOLLOW_UP = /^(?:continue|go on|keep going|carry on|proceed)(?:[.!]|\s+please[.!]?)?$/iu;

function operatorRequest(text: string, promptChars: unknown): string {
	const long = typeof promptChars === "number" ? promptChars > LONG_MESSAGE_CHARS : text.length > LONG_MESSAGE_CHARS;
	const prose =
		text
			.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*(?:\n|$)|$)/gmu, "\n")
			.replace(/<file\b[^>]*>[\s\S]*?(?:<\/file>|$)/giu, "\n")
			.replace(/<(?:paste|pasted|attachment)\b[^>]*>[\s\S]*?(?:<\/(?:paste|pasted|attachment)>|$)/giu, "\n")
			.replace(/^[ \t]*>[^\n]*/gmu, "")
			.split(/\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/iu)[0] ?? "";
	// Pi expands its visible paste tokens before submit. Headless input has no
	// provenance either, so a long unmarked tail belongs to the document (#431).
	return long
		? (prose
				.trimStart()
				.split(/\n[ \t]*\n/u)[0]
				?.slice(0, LONG_MESSAGE_CHARS) ?? "")
		: prose;
}

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
	let planOnly = false;
	let changed = false;
	let asked = false;
	let closed = false;
	// What armed this turn's close, reported with the effects it causes (#431).
	let armedBy = "regex:PLAN_REQUEST@operator-request";
	let pending: { at: number; sessionId: string | undefined; message: string } | null = null;
	return {
		id: "nudge.plan-close",
		description: "close an unapproved plan through ask_user once",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input, context) {
			if (input.hook === "turn_start") {
				armed = false;
				changed = false;
				asked = false;
				closed = false;
				const reminder = pending;
				pending = null;
				if (!deps.canAsk()) return [];
				if (
					reminder !== null &&
					reminder.sessionId === input.sessionId &&
					performance.now() - reminder.at < PLAN_CLOSE_REMINDER_IDLE_MS &&
					(input.metadata?.requestContinuation === true || PLAN_CLOSE_FOLLOW_UP.test(input.text?.trim() ?? ""))
				) {
					context?.evidence?.(
						input.metadata?.requestContinuation === true
							? "continuation:plan-close@turn"
							: "regex:PLAN_CLOSE_FOLLOW_UP@operator-request",
					);
					return [{ kind: "inject_reminder", audience: "model", message: reminder.message }];
				}
				if (input.metadata?.requestContinuation !== true) {
					const request = operatorRequest(input.text ?? "", input.metadata?.promptChars);
					const wantsPlan = PLAN_REQUEST.test(request) && !DISCUSSION_REQUEST.test(request);
					planOnly = wantsPlan && isPlanOnlyRequest(request);
					const proposal = input.metadata?.turnMode === "proposal";
					const verdict = deps.isPlan();
					armed = planOnly || proposal || (verdict ?? wantsPlan);
					armedBy = planOnly
						? "regex:PLAN_ONLY@operator-request"
						: proposal
							? "mode:proposal@turn"
							: verdict !== undefined
								? "verdict:system-one.turn@turn"
								: "regex:PLAN_REQUEST@operator-request";
				}
				if (armed) context?.evidence?.(armedBy);
				return armed
					? [
							{
								kind: "inject_reminder",
								audience: "model",
								message: `End the plan text without a question or option list; ask_user is its only close.${planOnly ? ' This is plan-only: the card must offer "Keep the plan (Recommended)" first, then any implementation choices, then "Revise the plan first".' : ""}`,
							},
						]
					: [];
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
			const message =
				(planOnly
					? 'This request is plan-only. Offer "Keep the plan (Recommended)" first; implementation is optional and is not recommended. '
					: "") +
				'Close this plan with ask_user "Carry out this plan?". Put any open choices in the options, with one-line descriptions and the recommended option first, and end with "Revise the plan first" so the operator can decline. Do not restate the plan.';
			const contextTokens = input.metadata?.contextTokens;
			if (typeof contextTokens === "number" && contextTokens >= PLAN_CLOSE_CONTEXT_THRESHOLD) {
				pending = { at: performance.now(), sessionId: input.sessionId, message };
				return [];
			}
			context?.evidence?.(armedBy);
			return [{ kind: "request_continuation", note: "", message }];
		},
	};
}
