import { SKILL_SUGGESTION_ANCHOR } from "../../core/skill-activation.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

/**
 * First-turn skills reminder. The skill-mastery batteries proved local
 * models read and ignore every ambient prompt channel but comply with the
 * identical instruction when it is visible user-message text, and
 * middleware reminders are the sanctioned mechanism for that text. Once
 * per session, on the first substantive task turn, when model-visible
 * skills exist, this registration injects one compact line teaching the
 * same reply protocol as the context(scope="skills") listing footer.
 * Reminder text only: loading stays operator-gated (`pendingSkillPolicy`
 * untouched), and a turn that already carries a pending skill request gets
 * no reminder because the operator has already chosen.
 */

export const SKILLS_REMINDER_REGISTRATION_ID = "observer.skills-reminder";

export { SKILL_SUGGESTION_ANCHOR };

export function skillsReminderMessage(count: number): string {
	// Unconditional imperative, deliberately: the skill-mastery batteries
	// showed literal local models comply with "list and check" but never act
	// on wording that first asks them to classify the task as skill-shaped.
	// One listing call on the session's first turn is the accepted price.
	return (
		`[Skills] ${count} installed. Start this task by listing them with context(scope="skills") ` +
		"and checking for a match; if one matches, open your reply with the line " +
		`\`${SKILL_SUGGESTION_ANCHOR}\` (a comma-separated sequence, in order, when several compose) ` +
		"and wait for the operator; load only on operator request. If none match, do not mention " +
		"skills and continue with the task."
	);
}

export interface SkillsReminderDeps {
	/** Count of skills the model may see and suggest; 0 disables the reminder. */
	countModelVisibleSkills(): number;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

function metadataNumber(input: MiddlewareHookInput, key: string): number | null {
	const value = input.metadata?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createSkillsReminderRegistration(deps: SkillsReminderDeps): MiddlewareHookRegistration {
	// The first turn_start of a fresh session fires before the session is
	// created, so sessionId can be null there; the spent flag tracks the
	// active session and resets when turn_start reports a different one
	// (new/resume/fork all route through a session change).
	let lastSeenSessionId: string | null | undefined;
	let spentForActiveSession = false;

	return {
		id: SKILLS_REMINDER_REGISTRATION_ID,
		description: "once per session, on the first substantive turn, teaches the skill-suggestion reply protocol",
		hooks: ["turn_start"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const sessionId = input.sessionId ?? null;
			if (lastSeenSessionId === undefined) {
				lastSeenSessionId = sessionId;
			} else if (sessionId !== lastSeenSessionId) {
				lastSeenSessionId = sessionId;
				spentForActiveSession = false;
			}
			if (spentForActiveSession) return NO_EFFECTS;
			// Any turn is this session's only chance: a follow-up or resumed
			// conversation (prior messages) marks the session spent without
			// reminding, so the line can never appear mid-session.
			spentForActiveSession = true;
			const conversationMessages = metadataNumber(input, "conversationMessages");
			if (conversationMessages === null || conversationMessages > 0) return NO_EFFECTS;
			// The operator already chose a skill for this turn; a reminder
			// about suggesting one would only add noise.
			const pendingSkillRequests = metadataNumber(input, "pendingSkillRequests");
			if (pendingSkillRequests !== null && pendingSkillRequests > 0) return NO_EFFECTS;
			let count = 0;
			try {
				count = deps.countModelVisibleSkills();
			} catch {
				return NO_EFFECTS;
			}
			if (count <= 0) return NO_EFFECTS;
			return [{ kind: "inject_reminder", severity: "info", message: skillsReminderMessage(count) }];
		},
	};
}
