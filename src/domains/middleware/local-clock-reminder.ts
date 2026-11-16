import { operatorCalendar } from "../../core/format-time.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect } from "./types.js";

export const LOCAL_CLOCK_REMINDER_REGISTRATION_ID = "observer.local-clock";

const NONE: ReadonlyArray<MiddlewareEffect> = [];

function clockText(now: number): { date: string; text: string } {
	const { date, weekday, time, zone } = operatorCalendar(now);
	return { date, text: `${date}${weekday ? ` (${weekday})` : ""} ${time}, ${zone}` };
}

/**
 * The operator's local time at the start of every turn, continuations
 * included, and again on the first tool result after the local date changes
 * inside a long turn. The system prompt carries only the date, so its prefix
 * changes once a day; the clock rides the uncached tail. A model that named an
 * archive for tomorrow had neither (WTF-P 0.8.3 A4).
 */
export function createLocalClockReminderRegistration(deps: { now?: () => number } = {}): MiddlewareHookRegistration {
	const now = deps.now ?? Date.now;
	let announcedDate: string | null = null;
	return {
		id: LOCAL_CLOCK_REMINDER_REGISTRATION_ID,
		description: "states the operator's local date, time and zone at each turn start and when the date changes mid-turn",
		hooks: ["turn_start", "after_tool"],
		evidence: "clock:operator-local",
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const clock = clockText(now());
			if (input.hook === "turn_start") {
				announcedDate = clock.date;
				return [{ kind: "inject_reminder", severity: "info", message: `[Clock] Operator's local time: ${clock.text}.` }];
			}
			// A nested gateway capability is the same call the outer occurrence reports.
			if (announcedDate === null || announcedDate === clock.date || input.metadata?.nested === true) return NONE;
			announcedDate = clock.date;
			return [
				{
					kind: "annotate_tool_result",
					severity: "info",
					message: `[Clock] The operator's local date changed during this turn; it is now ${clock.text}.`,
				},
			];
		},
	};
}
