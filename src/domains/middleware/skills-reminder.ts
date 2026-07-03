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

// Bare greetings/acknowledgements that carry no task. A turn is treated as a
// greeting only when EVERY token is one of these, so any real word ("fix",
// "how", a path) makes it substantive. Conservative by design: misclassifying
// a real task as a greeting would skip the reminder, so the set stays small.
const GREETING_WORDS = new Set([
	"hi",
	"hello",
	"hey",
	"heya",
	"hiya",
	"howdy",
	"yo",
	"sup",
	"hola",
	"greetings",
	"gm",
	"gn",
	"morning",
	"afternoon",
	"evening",
	"good",
	"day",
	"night",
	"there",
	"you",
	"clio",
	"thanks",
	"thank",
	"thankyou",
	"thx",
	"ty",
	"ok",
	"okay",
	"k",
	"cool",
	"nice",
	"test",
	"testing",
	"ping",
	"pong",
]);

/**
 * True when a user turn carries an actual task, false for a bare greeting or
 * acknowledgement ("hi", "hello there", "thanks"). Used to decide whether the
 * once-per-session skills reminder spends its shot on this turn. Conservative
 * toward substantive: empty input is the only non-greeting that returns false,
 * and any token outside {@link GREETING_WORDS} makes the whole turn substantive,
 * so a misclassification can only reproduce the pre-change behavior, never a
 * new false negative on a real task.
 */
export function isSubstantiveUserTurn(text: string | undefined): boolean {
	const normalized = (text ?? "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0) return false;
	const tokens = normalized.split(" ");
	// A short all-greeting message is not substantive; anything longer, or with
	// any non-greeting token, is a real task.
	if (tokens.length > 4) return true;
	return tokens.some((token) => !GREETING_WORDS.has(token));
}

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
	// True once we have observed this session from its opening turn (a turn with
	// an empty conversation). A greeting-first session grows its conversation
	// before the real task lands, so conversationMessages alone can no longer
	// tell "fresh session, still waiting for a substantive turn" from "resumed
	// mid-session": this flag carries that knowledge across the greeting turns.
	let observedFreshStart = false;
	let observedAnyTurn = false;

	return {
		id: SKILLS_REMINDER_REGISTRATION_ID,
		description: "once per session, on the first substantive turn, teaches the skill-suggestion reply protocol",
		hooks: ["turn_start"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const sessionId = input.sessionId ?? null;
			if (lastSeenSessionId === undefined) {
				lastSeenSessionId = sessionId;
			} else if (lastSeenSessionId === null && sessionId !== null) {
				// A fresh session's opening turn fires before the session is created
				// (null id); the session is created during that turn, so the next
				// turn carries the concrete id. That is the SAME session gaining an
				// id, not a new one, so adopt the id without resetting — otherwise a
				// greeting-first session would look brand new on its second turn.
				lastSeenSessionId = sessionId;
			} else if (sessionId !== lastSeenSessionId) {
				// A genuinely different session (new/resume/fork all route through a
				// concrete id change): reset the per-session state.
				lastSeenSessionId = sessionId;
				spentForActiveSession = false;
				observedFreshStart = false;
				observedAnyTurn = false;
			}
			if (spentForActiveSession) return NO_EFFECTS;

			const conversationMessages = metadataNumber(input, "conversationMessages");
			if (!observedAnyTurn) {
				observedAnyTurn = true;
				// A resumed/forked conversation is first observed with history
				// already present: mark it spent without ever reminding, so the
				// line can never surprise mid-session. We also can't reason about
				// freshness without the count, so treat unknown as spent.
				if (conversationMessages === null || conversationMessages > 0) {
					spentForActiveSession = true;
					return NO_EFFECTS;
				}
				observedFreshStart = true;
			}
			// Only a session we watched from its opening turn is eligible; a turn
			// we joined mid-stream never reminds.
			if (!observedFreshStart) {
				spentForActiveSession = true;
				return NO_EFFECTS;
			}

			// Bare greetings do not spend the shot: it carries to the first real
			// task turn. Everything from here consumes the session's one chance.
			if (!isSubstantiveUserTurn(input.text)) return NO_EFFECTS;
			spentForActiveSession = true;

			// The operator already chose a skill for this turn; a reminder about
			// suggesting one would only add noise.
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
