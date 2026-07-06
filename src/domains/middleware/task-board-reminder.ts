import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

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

export function taskBoardReminderMessage(steps: number): string {
	return (
		`[Tasks] This request enumerates ${steps} steps. Before the first edit, declare the task board: ` +
		'tasks action="plan" with a title and one task per step, then work them one at a time ' +
		'("start", then "done" with an evidence note).'
	);
}

/**
 * Count explicitly enumerated steps in a user turn. Only unambiguous
 * enumerations count: a run of numeric markers ("1)", "2.", "(3)", "step 4:")
 * that starts at 1 and increments without gaps, or three or more bulleted
 * lines. Prose that merely mentions numbers never triggers, so the reminder
 * cannot fire on ordinary requests.
 */
export function countEnumeratedSteps(text: string | undefined): number {
	const value = text ?? "";
	if (value.trim().length === 0) return 0;
	const markers: number[] = [];
	const markerPattern = /(?:^|[\s(])(?:step\s+)?([1-9])\s*[).:]\s/gi;
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

function metadataNumber(input: MiddlewareHookInput, key: string): number | null {
	const value = input.metadata?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const sessionId = input.sessionId ?? null;
			if (lastSeenSessionId === undefined || (lastSeenSessionId === null && sessionId !== null)) {
				lastSeenSessionId = sessionId;
			} else if (sessionId !== lastSeenSessionId) {
				lastSeenSessionId = sessionId;
				spentForActiveSession = false;
			}
			if (spentForActiveSession) return NO_EFFECTS;

			const steps = countEnumeratedSteps(input.text);
			if (steps < 3) return NO_EFFECTS;
			spentForActiveSession = true;

			// A turn already carrying an operator-chosen skill flows through that
			// skill's own workflow; do not compete with it.
			const pendingSkillRequests = metadataNumber(input, "pendingSkillRequests");
			if (pendingSkillRequests !== null && pendingSkillRequests > 0) return NO_EFFECTS;
			return [{ kind: "inject_reminder", severity: "info", message: taskBoardReminderMessage(steps) }];
		},
	};
}
