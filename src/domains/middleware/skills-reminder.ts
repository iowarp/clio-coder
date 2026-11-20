import { SKILL_SUGGESTION_ANCHOR, skillActivationFromToolDetails } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import { type TurnConstraints, turnAllowsTool } from "../../core/turn-constraints.js";
import { workspaceStoreTags } from "../store/index.js";
import { type CapabilityMatch, capabilityWorthNaming } from "./capability-gate.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import { isSkillSuggestionWait, SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE } from "./stalled-turn.js";
import { type MiddlewareEffect, metadataNumber } from "./types.js";

/** Task-ranked workflow advice; count-only hosts retain their once-per-session fallback. */

export const SKILLS_REMINDER_REGISTRATION_ID = "observer.skills-reminder";

export { SKILL_SUGGESTION_ANCHOR };

export function skillsReminderMessage(installed: number, installable = 0, modelActivation = false): string {
	if (installed <= 0) return "";
	const counts = `${installed} ready Clio skill${installed === 1 ? "" : "s"}`;
	const discovery =
		"If a workflow would help the requested work, choose from the installed catalog. Skip discovery for self-contained answers and respect tool and task restrictions. ";
	const activation = modelActivation
		? 'For a matching ready skill, load it with context(scope="skills", name="<name>") and continue the task in the same turn.'
		: `For a match, suggest \`${SKILL_SUGGESTION_ANCHOR}\` and continue the task in the same turn without it; only the operator loads a skill.`;
	return `[Skills] ${counts}. ${discovery}${activation}${installable > 0 ? " Marketplace installation requires operator approval." : ""}`;
}

export interface SkillsReminderDeps {
	/** Pre-turn advice from the shared gate; absence preserves the legacy host protocol. */
	rankSkills?(task: string): ReadonlyArray<CapabilityMatch>;
	/** The ranked matches still fit to show a model; the unchanged-list check keys on what it returns. */
	verifyRankedSkills?(matches: ReadonlyArray<CapabilityMatch>): ReadonlyArray<CapabilityMatch>;
	/** Only admitted gateway-placed capabilities; direct tools already carry their schemas. */
	rankCapabilities?(task: string): ReadonlyArray<CapabilityMatch>;
	/** Coordinator registries may override context's default direct placement. */
	contextPlacement?(): "direct" | "gateway";
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
	/** The workspace whose project store tags a store hint names; the process cwd by default. */
	cwd?(): string;
}

const STORE_TAGS_NAMED = 5;
const STORE_TAG_CHARS = 40;

/** At most five tag names, each clipped, then a count of the rest, so a large store keeps the hint short. */
function storeTagList(tags: ReadonlyArray<string>): string {
	const named = tags.slice(0, STORE_TAGS_NAMED).map((tag) => `\`${clip(tag, STORE_TAG_CHARS)}\``);
	const rest = tags.length - named.length;
	return `${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

/** Cuts at the last word boundary within the limit, so no word is shown half. */
function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const cut = text.slice(0, limit);
	const space = text[limit] === " " ? limit : cut.lastIndexOf(" ");
	return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/u, "")}…`;
}

function storeSignalled(capabilities: ReadonlyArray<CapabilityMatch>): boolean {
	return capabilities.slice(0, 3).some((match) => match.workspaceSignal && match.id === ToolNames.Store);
}

function rankedSkillsReminder(
	matches: ReadonlyArray<CapabilityMatch>,
	modelActivation: boolean,
	capabilities: ReadonlyArray<CapabilityMatch> = [],
	contextPlacement: "direct" | "gateway" = "direct",
	storeTags: ReadonlyArray<string> = [],
): string {
	const lines = matches
		.slice(0, 5)
		.map((match) => `- ${match.id}: ${clip(match.description.replace(/\s+/gu, " ").trim(), 150)}`);
	const load =
		contextPlacement === "gateway"
			? 'gateway(op="call", capability="context", args={scope:"skills",name:"<name>"})'
			: 'context(scope="skills", name="<name>")';
	const skills =
		matches.length === 0
			? []
			: [
					"[Skills] Likely workflows for this task; skip all if none fits. Respect tool and task restrictions.",
					...lines,
					modelActivation
						? `Load the one for the current step with ${load}; another may follow. Continue the task.`
						: `Suggest \`${SKILL_SUGGESTION_ANCHOR}\` with the one for the current step; another may follow. Continue without waiting; only the operator loads a skill.`,
				];
	const names = capabilities.slice(0, 3).map((match) => match.id);
	const store = !storeSignalled(capabilities)
		? ""
		: storeTags.length > 0
			? ` This project's store holds tagged data (tags ${storeTagList(storeTags)}); store op=tags lists them.`
			: " This project's store holds tagged data; store op=tags lists it.";
	return [
		...skills,
		...(names.length > 0
			? [
					`[Capabilities] Likely useful: ${names.join(", ")}.${store} Use gateway(op="call", capability="<name>", args={...}) when needed; admission still applies.`,
				]
			: []),
	].join("\n");
}

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

// Greeting words that open an address, a subset of GREETING_WORDS.
const SALUTATIONS = new Set([
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
	"morning",
	"afternoon",
	"evening",
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
	// A salutation plus one address term ("sup fool", "hey buddy") is still a
	// greeting; the open vocabulary of address terms cannot be listed. An
	// acknowledgement leads real instructions ("ok proceed"), so it does not
	// count. A real two-word task led by a salutation only defers the reminder.
	if (tokens.length === 2 && SALUTATIONS.has(tokens[0] ?? "")) return false;
	return tokens.some((token) => !GREETING_WORDS.has(token));
}

/** How many recent tool calls lend their names to the skills query (MD13). */
const RECENT_TOOLS = 5;

/**
 * A turn whose text the operator wrote. A yolo continuation, a job's machine
 * turn, a peer's message and a request continuation carry host or agent text,
 * so the ranking keeps the operator's last task instead (MD13). A host that
 * stamps no origin is read as the operator, as before origins existed.
 */
function operatorAuthoredTurn(input: { metadata?: Readonly<Record<string, unknown>> }): boolean {
	if (input.metadata?.requestContinuation === true) return false;
	const origin = input.metadata?.turnOrigin;
	return origin === undefined || origin === "operator";
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
	// Ranked hosts, per session: the operator's last substantive task, the last
	// list delivered, the skills a tool result showed loaded, and recent tools.
	let task = "";
	let deliveredIds = "";
	const loadedSkills = new Set<string>();
	let recentTools: string[] = [];

	/** True when turn_start reports a different session than the one being tracked. */
	const sessionChanged = (sessionId: string | null): boolean => {
		// A fresh session's opening turn fires before the session is created
		// (null id); the session is created during that turn, so the next turn
		// carries the concrete id. That is the SAME session gaining an id, not a
		// new one, so adopt the id without resetting; otherwise a greeting-first
		// session would look brand new on its second turn.
		if (lastSeenSessionId === undefined || (lastSeenSessionId === null && sessionId !== null)) {
			lastSeenSessionId = sessionId;
			return false;
		}
		if (sessionId === lastSeenSessionId) return false;
		lastSeenSessionId = sessionId;
		return true;
	};

	return {
		id: SKILLS_REMINDER_REGISTRATION_ID,
		description:
			"suggests task-relevant workflows within the skill activation policy; continues a turn that stopped on a suggestion",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evidence: "rank:skills@task",
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const ranked = deps.rankSkills !== undefined || deps.rankCapabilities !== undefined;
			// Observation only: the tools the session just used and the skills a
			// successful context load returned. Nothing is emitted at a tool boundary.
			if (input.hook === "after_tool") {
				const tool = input.toolName ?? "";
				if (!ranked || tool.length === 0) return NO_EFFECTS;
				// A gateway call is seen again under the capability it ran (nested), which names the step.
				// The window is the last five calls, repeats included, so a run of reads pushes an older tool out.
				if (tool !== ToolNames.Gateway) recentTools = [...recentTools, tool].slice(-RECENT_TOOLS);
				if (tool === ToolNames.Context && input.metadata?.resultKind === "ok") {
					const activation = skillActivationFromToolDetails(input.toolResultDetails);
					if (activation !== null) loadedSkills.add(activation.name);
				}
				return NO_EFFECTS;
			}
			const constraints = deps.getTurnConstraints?.();
			const suppressed =
				constraints?.mode === "answer" ||
				constraints?.mode === "proposal" ||
				constraints?.skills === "disabled" ||
				!turnAllowsTool(constraints, "context") ||
				(deps.contextPlacement?.() === "gateway" && !turnAllowsTool(constraints, "gateway"));
			// The registration that teaches "suggest, then continue" owns the
			// consequence when a model suggests and stops. The generic stalled-turn
			// rule cannot see this case: the listing call counts as a tool call.
			if (input.hook === "turn_end") {
				if (suppressed || !isSkillSuggestionWait(input)) return NO_EFFECTS;
				try {
					return deps.countModelVisibleSkills() > 0
						? [
								{
									kind: "request_continuation",
									message: SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE,
									note: "the reply stopped on a skill suggestion",
								},
							]
						: NO_EFFECTS;
				} catch {
					return NO_EFFECTS;
				}
			}
			if (ranked) {
				if (input.hook !== "turn_start") return NO_EFFECTS;
				if (sessionChanged(input.sessionId ?? null)) {
					task = "";
					deliveredIds = "";
					loadedSkills.clear();
					recentTools = [];
				}
				if (operatorAuthoredTurn(input)) {
					// A greeting or acknowledgement keeps the task it follows and ranks nothing.
					if (!isSubstantiveUserTurn(input.text)) return NO_EFFECTS;
					task = input.text ?? "";
					// The operator already chose a skill for this turn.
					if ((metadataNumber(input, "pendingSkillRequests") ?? 0) > 0) return NO_EFFECTS;
				}
				if (constraints?.mode === "answer" || constraints?.mode === "proposal" || !isSubstantiveUserTurn(task))
					return NO_EFFECTS;
				const window = [...new Set([...recentTools].reverse())];
				const query = window.length > 0 ? `${task}\n${window.join(" ")}` : task;
				const matches = suppressed ? [] : (deps.rankSkills?.(query) ?? []).filter((match) => !loadedSkills.has(match.id));
				const capabilities = turnAllowsTool(constraints, "gateway")
					? (deps.rankCapabilities?.(task) ?? [])
							.filter((match) => turnAllowsTool(constraints, match.id) && capabilityWorthNaming(match, task))
							.slice(0, 3)
					: [];
				const storeTags = storeSignalled(capabilities) ? workspaceStoreTags(deps.cwd?.() ?? process.cwd()) : [];
				if (matches.length === 0 && capabilities.length === 0) return NO_EFFECTS;
				// Keyed on what would be displayed: a skill the verifier rejected and later
				// accepts is a change, and a change among rejected candidates is not.
				const shown = matches.length === 0 ? [] : (deps.verifyRankedSkills?.(matches) ?? matches);
				if (shown.length === 0 && capabilities.length === 0) return NO_EFFECTS;
				const ids = JSON.stringify([
					shown.slice(0, 5).map((match) => match.id),
					capabilities.map((match) => match.id),
					storeTags.slice(0, STORE_TAGS_NAMED),
					storeTags.length,
				]);
				// The last delivered list is still in the conversation; an equal one adds nothing.
				if (ids === deliveredIds) return NO_EFFECTS;
				deliveredIds = ids;
				return [
					{
						kind: "inject_reminder",
						severity: "info",
						audience: "model",
						message: rankedSkillsReminder(
							shown,
							deps.modelMayActivateSkills?.() ?? false,
							capabilities,
							deps.contextPlacement?.() ?? "direct",
							storeTags,
						),
					},
				];
			}
			if (input.hook !== "turn_start") return NO_EFFECTS;
			if (sessionChanged(input.sessionId ?? null)) {
				// A genuinely different session (new/resume/fork all route through a
				// concrete id change): reset the per-session state.
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
