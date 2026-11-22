import { isPlanOnlyRequest } from "../../core/plan-request.js";
import { requestProse } from "../../core/request-prose.js";
import { ToolNames } from "../../core/tool-names.js";
import { forbidsFileWrites } from "../../core/write-prohibition.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import { parallelPartsCount } from "./turn-plan-cue.js";
import { type MiddlewareEffect, metadataNumber, metadataString, turnCanCallTool } from "./types.js";

/**
 * Task-board reminder for explicitly enumerated multi-step requests. The
 * skill-mastery batteries established that local models read and ignore
 * ambient prompt channels (the Tool Contract routing line and the tasks
 * prompt hint both ask for a board before multi-step work) but comply with
 * the identical instruction as visible user-message text. Once per session,
 * on the first turn whose user text literally enumerates three or more
 * steps, this registration injects one compact line telling the model to
 * open the board first. Reminder text only: no tool policy changes.
 */

export const TASK_BOARD_REMINDER_REGISTRATION_ID = "observer.task-board-reminder";

export function taskBoardReminderMessage(steps: number, placement: "direct" | "gateway" = "direct"): string {
	// A gateway-only tasks has no attached schema, and a model told to call
	// tasks concluded the tool did not exist (bt-22), so name the call it can make.
	const plan =
		placement === "gateway"
			? 'gateway(op="call", capability="tasks", args={action:"plan", title:"<board>", tasks:["<one per authorized step>"]}) ' +
				"(tasks has no attached schema; every tasks action below goes through gateway this way), then "
			: 'tasks action="plan" with a title and one task per authorized step, then ';
	return (
		`[Tasks] This request enumerates ${steps} steps. Before the first edit, declare the task board: ${plan}` +
		"track each step as it starts and finishes, including parts dispatched together " +
		'("start", then "done" with note="<observed work and check results>", disclosing failed or unrun checks). ' +
		"Bookkeeping is not a reason to end a model response: for dependent steps with known IDs and arguments, use gateway op=chain for " +
		"done -> start -> next read/work, or decide -> authorized implementation, with each dependent step's after naming its predecessor's step id. " +
		"Never predict results or prewrite done for work/checks in that chain. Successful returned board and operator-task state is authoritative; " +
		"list only if it is missing, stale or inconsistent. Failed or partial updates are not completion; reconcile actual state before claiming success. " +
		"Initial ID discovery and final closure may stand alone. A plan or decision does not authorize implementation: " +
		'for proposed work awaiting an operator go-ahead, use action="block" with a note naming the pending operator decision, ' +
		'or action="drop", and wait.'
	);
}

/**
 * Count explicitly enumerated steps in a user turn. Only unambiguous
 * enumerations count: a run of numeric markers ("1)", "2.", "(3)", "step 4:")
 * that starts at 1 and increments without gaps, or three or more bulleted
 * lines. Prose that merely mentions numbers never triggers, so the reminder
 * cannot fire on ordinary requests; nor does a `Line 2:` label, which numbers
 * content, not steps (SF-14).
 */
export function countEnumeratedSteps(text: string | undefined): number {
	const value = text ?? "";
	if (value.trim().length === 0) return 0;
	const markers: number[] = [];
	const markerPattern = /(?:^|(?<!\blines?)[\s(])(?:step\s+)?([1-9])\s*[).:]\s/gi;
	let match = markerPattern.exec(value);
	while (match !== null) {
		const digit = Number(match[1]);
		if (Number.isInteger(digit)) markers.push(digit);
		match = markerPattern.exec(value);
	}
	let run = 0;
	for (const digit of markers) {
		if (digit === run + 1) run += 1;
		else if (digit === 1) run = 1;
	}
	if (run >= 3) return run;
	const bulletLines = value.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
	return bulletLines >= 3 ? bulletLines : 0;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

export function createTaskBoardReminderRegistration(): MiddlewareHookRegistration {
	// Same session-tracking shape as the skills reminder: the opening turn of a
	// fresh session can fire before the session id exists, and a genuinely
	// different id resets the per-session state.
	let lastSeenSessionId: string | null | undefined;
	let spentForActiveSession = false;

	return {
		id: TASK_BOARD_REMINDER_REGISTRATION_ID,
		description: "once per session, on the first explicitly enumerated multi-step turn, teaches the board-first protocol",
		hooks: ["turn_start"],
		evidence: "count:enumerated-steps@operator-request",
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const sessionId = input.sessionId ?? null;
			if (lastSeenSessionId === undefined || (lastSeenSessionId === null && sessionId !== null)) {
				lastSeenSessionId = sessionId;
			} else if (sessionId !== lastSeenSessionId) {
				lastSeenSessionId = sessionId;
				spentForActiveSession = false;
			}
			if (spentForActiveSession) return NO_EFFECTS;

			// A step template's turn runs one step per turn, so its enumerated steps are the pipeline's,
			// not a task list for this turn; the shot is kept for a later turn.
			if (input.metadata?.turnStepPolicy === true) return NO_EFFECTS;
			// A request the host scoped to an answer, a proposal or read-only work changes nothing, so a board
			// for its enumerated questions is ceremony (bt-22: 13 tasks calls on a read-only explanation). So
			// is one whose own words forbid writing any file, though no flag scoped it.
			const mode = input.metadata?.turnMode;
			if (mode === "answer" || mode === "proposal" || input.metadata?.turnReadOnly === true) return NO_EFFECTS;
			const text = requestProse(input.text ?? "");
			if (isPlanOnlyRequest(text) || forbidsFileWrites(text)) return NO_EFFECTS;
			const steps = countEnumeratedSteps(text);
			if (steps < 3) return NO_EFFECTS;
			// The reminder names tasks and gateway op=chain; a turn that cannot call
			// both would spend its steps hunting. The shot is kept for a later
			// enumerated turn that can.
			if (!turnCanCallTool(input, ToolNames.Tasks) || !turnCanCallTool(input, ToolNames.Gateway)) return NO_EFFECTS;
			spentForActiveSession = true;
			// A turn the turn-plan cue reads as parallel parts gets its board steps inside that one note, so two notes
			// never compete in one reminder block (lab L7). The shot is spent: the board was taught this session.
			if (parallelPartsCount(input) > 0) return NO_EFFECTS;

			// A turn already carrying an operator-chosen skill flows through that
			// skill's own workflow; do not compete with it.
			const pendingSkillRequests = metadataNumber(input, "pendingSkillRequests");
			if (pendingSkillRequests !== null && pendingSkillRequests > 0) return NO_EFFECTS;
			const attached = metadataString(input, "activeToolNames");
			const placement =
				attached !== null && !attached.split(",").some((name) => name.trim() === ToolNames.Tasks) ? "gateway" : "direct";
			return [{ kind: "inject_reminder", severity: "info", message: taskBoardReminderMessage(steps, placement) }];
		},
	};
}
