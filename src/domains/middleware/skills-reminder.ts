import { SKILL_SUGGESTION_ANCHOR } from "../../core/skill-activation.js";
import { type TurnConstraints, turnAllowsTool } from "../../core/turn-constraints.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import { isSkillSuggestionWait, SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE } from "./stalled-turn.js";
import { type MiddlewareEffect, metadataNumber } from "./types.js";

/** Once per fresh session, offer ready workflows without making discovery a task prerequisite. */

export const SKILLS_REMINDER_REGISTRATION_ID = "observer.skills-reminder";

export { SKILL_SUGGESTION_ANCHOR };

export function skillsReminderMessage(installed: number, installable = 0, modelActivation = false): string {
	if (installed <= 0) return "";
	const counts = `${installed} ready Clio skill${installed === 1 ? "" : "s"}`;
	const discovery =
		'If a workflow would help the requested work, inspect context(scope="skills"). Skip discovery for self-contained answers and respect tool and task restrictions. ';
	const activation = modelActivation
		? 'For a matching ready skill, load it with context(scope="skills", name="<name>") and continue the task in the same turn.'
		: `For a match, suggest \`${SKILL_SUGGESTION_ANCHOR}\` and continue the task in the same turn without it; only the operator loads a skill.`;
	return `[Skills] ${counts}. ${discovery}${activation}${installable > 0 ? " Marketplace installation requires operator approval." : ""}`;
}

export interface SkillsReminderDeps {
	/** Same host-owned scope used by tool admission and prompt composition. */
	getTurnConstraints?(): TurnConstraints | undefined;
	/** Count of installed skills the model may see and suggest. */
	countModelVisibleSkills(): number;
	/**
	 * Count of marketplace skills not yet installed. Optional; absent reads as
	 * zero. Marketplace entries alone never arm the reminder.
	 */
	countInstallableSkills?(): number;
	/**
	 * True when the session's autonomy level lets the model activate an
	 * installed skill itself. Absent reads as false, the operator-gated wording
	 * every surface taught before the level became the opt-in.
	 */
	modelMayActivateSkills?(): boolean;
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
		description:
			"once per session, on the first substantive turn, teaches the skill-suggestion reply protocol; keeps a turn going that stopped on the suggestion",
		hooks: ["turn_start", "turn_end"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const constraints = deps.getTurnConstraints?.();
			const suppressed =
				constraints?.mode === "answer" ||
				constraints?.mode === "proposal" ||
				constraints?.skills === "disabled" ||
				!turnAllowsTool(constraints, "context");
			// The registration that teaches "suggest, then continue" owns the
			// consequence when a model suggests and stops. The generic stalled-turn
			// rule cannot see this case: the listing call counts as a tool call.
			if (input.hook === "turn_end") {
				if (suppressed || !isSkillSuggestionWait(input)) return NO_EFFECTS;
				try {
					return deps.countModelVisibleSkills() > 0
						? [{ kind: "request_continuation", message: SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE }]
						: NO_EFFECTS;
				} catch {
					return NO_EFFECTS;
				}
			}
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
			if (suppressed) return NO_EFFECTS;

			// The operator already chose a skill for this turn; a reminder about
			// suggesting one would only add noise.
			const pendingSkillRequests = metadataNumber(input, "pendingSkillRequests");
			if (pendingSkillRequests !== null && pendingSkillRequests > 0) return NO_EFFECTS;
			let installed = 0;
			let installable = 0;
			try {
				installed = deps.countModelVisibleSkills();
				if (installed <= 0) return NO_EFFECTS;
				installable = deps.countInstallableSkills?.() ?? 0;
			} catch {
				return NO_EFFECTS;
			}
			let modelActivation = false;
			try {
				modelActivation = deps.modelMayActivateSkills?.() ?? false;
			} catch {
				// An unreadable autonomy level falls back to the operator-gated wording.
			}
			return [
				{
					kind: "inject_reminder",
					severity: "info",
					message: skillsReminderMessage(installed, installable, modelActivation),
				},
			];
		},
	};
}
