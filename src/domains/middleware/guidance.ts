import {
	type HarnessProfile,
	readHarnessProfile,
	recordHarnessFeature,
	recordHarnessTopic,
	recordLessonShown,
} from "../../core/harness-profile.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

/**
 * Post-turn capability tips for the operator (demo guidance).
 *
 * The harness, not the model, decides when a tip helps: it watches the turn
 * (the prompt, the tools and shell commands it ran, how long the answer was)
 * and the operator's harness profile, scores a small catalog of lessons, and
 * shows at most one as an operator-only notice after the turn ends. Nothing
 * here reaches model context, costs a model call, or changes the prompt. Every
 * lesson names a command or key that exists; a key lesson whose binding is
 * unset is skipped rather than invented.
 */

export const GUIDANCE_REGISTRATION_ID = "observer.guidance";

/** A lesson retires after this many showings across all sessions. */
export const LESSON_LIFETIME_SHOWS = 2;
/** Tips per session. */
export const SESSION_TIP_BUDGET = 4;
/** Substantive turns between tips, unless a lesson answers the prompt directly. */
export const TURNS_BETWEEN_TIPS = 3;
/** A lesson at or above this score answers the prompt itself and may skip the spacing. */
const DIRECT_SCORE = 3;

export interface GuidanceTurn {
	/** The operator's prompt for this turn. */
	prompt: string;
	/** Model-visible conversation before this prompt; 0 on a session's opening turn. */
	priorMessages: number;
	/** Tool calls by name, gateway calls by capability (`gateway:clio_docs`). */
	tools: Map<string, number>;
	/** Shell commands the turn ran, in order. */
	commands: string[];
	/** Paths the turn read, listed, or searched. */
	paths: string[];
	assistantChars: number;
	toolCalls: number;
}

export interface GuidanceContext {
	autonomy: string;
	/** The display label bound to a keybinding id, or null when unbound. */
	keyFor(actionId: string): string | null;
	/** Whether the project has a CLIO-CODER.md. */
	hasProjectContext: boolean;
	/** Fraction of the context window in use, when known. */
	contextPressure: number | null;
	profile: HarnessProfile;
	/** First path-like token in the prompt that is not already an @ mention. */
	promptPath: string | null;
}

export interface GuidanceLesson {
	id: string;
	/** The feature this lesson teaches; once the operator uses it, the lesson retires. */
	feature: string;
	/** 0 when the lesson does not apply; higher is more relevant. */
	score(turn: GuidanceTurn, context: GuidanceContext): number;
	/** The tip, or null when a key it names is unbound. */
	text(context: GuidanceContext): string | null;
}

const GIT_HISTORY = /\bgit\s+(?:commit|rebase|merge|cherry-pick|revert)\b/u;
const QUESTION =
	/\b(?:how\s+(?:do|can|should)\s+i|is\s+there\s+a\s+way|can\s+(?:i|you)|where\s+(?:do|can|is)|what(?:'s|\s+is)\s+the)\b/iu;
const ABOUT_CLIO = /\b(?:clio(?:-coder)?|this\s+(?:harness|tool|cli|agent))\b/iu;
const SETTINGS_CHANGE =
	/\b(?:switch|change|use|set|pick|select)\b.{0,40}\b(?:model|provider|target|thinking(?:\s+level)?|autonomy|settings?)\b/iu;
const WRITE_TESTS = /\b(?:write|add|create)\b.{0,30}\b(?:unit\s+|regression\s+)?tests?\b/iu;
const CORRECTION =
	/^\s*(?:no\b[,.!]?|nope\b|undo\b|revert\s+that|go\s+back|that'?s\s+(?:wrong|not)|not\s+what\s+i|wait\b[,.!])/iu;
const SIDE_QUESTION = /^\s*(?:btw|by\s+the\s+way|quick\s+question|side\s+question|unrelated)\b[,:\s]/iu;
const PATH_TOKEN = /(?:^|[\s(`'"])((?:\.{0,2}\/)?[\w.-]+\/[\w./-]*\.[A-Za-z0-9]{1,8})\b/u;

/** Harness topics a question can be about, recorded in the profile. */
const TOPICS: ReadonlyArray<[string, RegExp]> = [
	["settings", /\b(?:settings?|config(?:ure|uration)?|preferences?)\b/iu],
	["model", /\b(?:models?|providers?|targets?|thinking)\b/iu],
	["keys", /\b(?:shortcuts?|keybindings?|hotkeys?|keys?)\b/iu],
	["agents", /\b(?:agents?|dispatch|fleet|workers?|delegat\w*)\b/iu],
	["sessions", /\b(?:sessions?|resume|history|fork|tree)\b/iu],
	["context", /\b(?:context|compact\w*|tokens?)\b/iu],
	["skills", /\b(?:skills?|plugins?|extensions?|mcp)\b/iu],
];

/** Topics of a prompt that asks about the harness itself; empty for ordinary work. */
export function harnessQuestionTopics(prompt: string): string[] {
	if (!QUESTION.test(prompt)) return [];
	const topics = TOPICS.filter(([, pattern]) => pattern.test(prompt)).map(([topic]) => topic);
	if (ABOUT_CLIO.test(prompt)) return topics.length > 0 ? topics : ["clio"];
	// Without naming Clio, only topics that cannot be ordinary project work count.
	return topics.filter((topic) => topic === "settings" || topic === "keys");
}

function used(turn: GuidanceTurn, name: string): number {
	return turn.tools.get(name) ?? 0;
}

function withKey(context: GuidanceContext, actionId: string, render: (key: string) => string): string | null {
	const key = context.keyFor(actionId);
	return key === null ? null : render(key);
}

export const GUIDANCE_LESSONS: ReadonlyArray<GuidanceLesson> = [
	{
		id: "settings-change",
		feature: "configure",
		score: (turn) =>
			QUESTION.test(turn.prompt) && SETTINGS_CHANGE.test(turn.prompt) && used(turn, "gateway:configure_clio") === 0
				? DIRECT_SCORE
				: 0,
		text: (context) =>
			context.autonomy === "auto-edit" || context.autonomy === "full-auto"
				? "Next time just ask: I can preview a Clio settings change for you to Apply. /model and /settings open the same controls."
				: "/model switches the chat model, and /settings holds every other Clio option.",
	},
	{
		id: "ask-clio",
		feature: "ask-clio",
		score: (turn) => (harnessQuestionTopics(turn.prompt).length > 0 && used(turn, "gateway:clio_docs") === 0 ? 2 : 0),
		text: () =>
			"Ask me anything about Clio herself: I answer from my bundled docs, source and live settings. /help <query> searches commands and keys.",
	},
	{
		id: "side-question",
		feature: "/btw",
		score: (turn) => (SIDE_QUESTION.test(turn.prompt) ? 2 : 0),
		text: () => "/btw <question> asks a side question that never enters this session's transcript.",
	},
	{
		id: "rewind",
		feature: "/tree",
		score: (turn) => (turn.priorMessages > 0 && CORRECTION.test(turn.prompt) ? 2 : 0),
		text: () =>
			"/tree jumps back to an earlier turn: pick the reply before a detour, and your next prompt continues from there without the detour in my context.",
	},
	{
		id: "context-pressure",
		feature: "/context",
		score: (_turn, context) => ((context.contextPressure ?? 0) >= 0.7 ? 2 : 0),
		text: () => "/context shows what fills the window, and /context compact summarizes older turns to free room.",
	},
	{
		id: "shell",
		feature: "!",
		score: (turn) =>
			turn.commands.length === 1 && turn.toolCalls <= 2 && /^\s*(?:please\s+)?(?:run|execute)\b/iu.test(turn.prompt)
				? 2
				: 0,
		text: () =>
			"Type !<command> to run a shell command yourself: its output joins this conversation, and !! keeps it out of my context.",
	},
	{
		id: "tester",
		feature: "/run",
		score: (turn) => (WRITE_TESTS.test(turn.prompt) ? 1 : 0),
		text: () => "/run tester <task> hands focused regression tests to the tester agent while we keep working here.",
	},
	{
		id: "git-master",
		feature: "/run",
		score: (turn) => (turn.commands.some((command) => GIT_HISTORY.test(command)) ? 1 : 0),
		text: () => "/run git-master <task> hands commits, rebases and branch cleanup to a dedicated git agent.",
	},
	{
		id: "at-mention",
		feature: "@",
		score: (turn, context) =>
			context.promptPath !== null && turn.paths.some((path) => path.endsWith(context.promptPath ?? "")) ? 1 : 0,
		text: (context) =>
			`Prefix a path with @, like @${context.promptPath}, to attach the file to your message; /files opens a picker.`,
	},
	{
		id: "view",
		feature: "/view",
		score: (turn) => (turn.toolCalls >= 10 ? 1 : 0),
		text: () => "/view browses every tool call and result from this session; Enter on one shows it in full.",
	},
	{
		id: "project-context",
		feature: "/context init",
		score: (turn, context) =>
			!context.hasProjectContext &&
			used(turn, "read") + used(turn, "grep") + used(turn, "find") + used(turn, "ls") + used(turn, "code_nav") >= 6
				? 1
				: 0,
		text: () =>
			"/context init writes a CLIO-CODER.md from this repository's conventions, so every new session starts with them.",
	},
	{
		id: "output-style",
		feature: "output-style",
		score: (turn) => (turn.assistantChars >= 6_000 ? 1 : 0),
		text: (context) =>
			withKey(
				context,
				"clio-coder.output.cycle",
				(key) => `${key} cycles output styles: compact folds tool trails, detailed shows every step.`,
			),
	},
	{
		id: "welcome",
		feature: "/help",
		score: (turn, context) => (turn.priorMessages === 0 && Object.keys(context.profile.lessons).length === 0 ? 0.5 : 0),
		text: () => "/help lists every command and key, and you can ask me about Clio herself any time.",
	},
];

/** The lesson to show after `turn`, or null. Pure: the caller enforces spacing and records the showing. */
function pickGuidanceLesson(
	turn: GuidanceTurn,
	context: GuidanceContext,
	shownThisSession: ReadonlySet<string>,
	lessons: ReadonlyArray<GuidanceLesson> = GUIDANCE_LESSONS,
): { lesson: GuidanceLesson; score: number; text: string } | null {
	let best: { lesson: GuidanceLesson; score: number; text: string } | null = null;
	for (const lesson of lessons) {
		if (shownThisSession.has(lesson.id)) continue;
		if ((context.profile.features[lesson.feature] ?? 0) > 0) continue;
		if ((context.profile.lessons[lesson.id]?.shown ?? 0) >= LESSON_LIFETIME_SHOWS) continue;
		const score = lesson.score(turn, context);
		if (score <= 0 || (best !== null && score <= best.score)) continue;
		const text = lesson.text(context);
		if (text !== null) best = { lesson, score, text };
	}
	return best;
}

export interface GuidanceDeps {
	/** interface.demo, read live so the settings toggle takes effect at once. */
	enabled(): boolean;
	autonomy(): string;
	keyFor(actionId: string): string | null;
	hasProjectContext(): boolean;
	contextPressure?(): number | null;
	/** Profile I/O; defaults to the state-dir harness profile. */
	profile?: {
		read(): HarnessProfile;
		lessonShown(id: string): void;
		feature(name: string): void;
		topic(name: string): void;
	};
}

function stringArg(args: Record<string, unknown> | undefined, name: string): string | null {
	const value = args?.[name];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function createGuidanceRegistration(deps: GuidanceDeps): MiddlewareHookRegistration {
	const profile = deps.profile ?? {
		read: readHarnessProfile,
		lessonShown: (id: string) => recordLessonShown(id),
		feature: recordHarnessFeature,
		topic: recordHarnessTopic,
	};
	let turn: GuidanceTurn | null = null;
	let lastSeenSessionId: string | null | undefined;
	let shown = new Set<string>();
	let turnsSinceTip = TURNS_BETWEEN_TIPS;

	const trackSession = (input: MiddlewareHookInput): void => {
		const sessionId = input.sessionId ?? null;
		// A fresh session's opening turn fires before the session exists; the
		// created session then fills in the id without counting as a switch.
		if (lastSeenSessionId === undefined || (lastSeenSessionId === null && sessionId !== null)) {
			lastSeenSessionId = sessionId;
			return;
		}
		if (sessionId === lastSeenSessionId) return;
		lastSeenSessionId = sessionId;
		shown = new Set();
		turnsSinceTip = TURNS_BETWEEN_TIPS;
	};

	const observeTool = (input: MiddlewareHookInput, current: GuidanceTurn): void => {
		const name = input.toolName ?? "";
		const capability = name === "gateway" ? stringArg(input.toolArgs, "capability") : null;
		const key = capability ? `gateway:${capability}` : name;
		current.tools.set(key, (current.tools.get(key) ?? 0) + 1);
		if (capability === "clio_docs") profile.feature("ask-clio");
		if (capability === "configure_clio") profile.feature("configure");
		const command = name === "bash" ? stringArg(input.toolArgs, "command") : null;
		if (command) current.commands.push(command);
		const path = stringArg(input.toolArgs, "path");
		if (path && ["read", "ls", "grep", "find"].includes(name)) current.paths.push(path);
	};

	const finish = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		const current = turn;
		turn = null;
		if (current === null) return [];
		current.assistantChars = Number(input.metadata?.assistantTextChars ?? 0) || 0;
		current.toolCalls = Number(input.metadata?.turnToolCalls ?? 0) || 0;
		turnsSinceTip += 1;
		if (shown.size >= SESSION_TIP_BUDGET) return [];
		const promptPathMatch = PATH_TOKEN.exec(current.prompt);
		const promptPath =
			promptPathMatch?.[1] && !current.prompt.includes(`@${promptPathMatch[1]}`) ? promptPathMatch[1] : null;
		const context: GuidanceContext = {
			autonomy: deps.autonomy(),
			keyFor: deps.keyFor,
			hasProjectContext: deps.hasProjectContext(),
			contextPressure: deps.contextPressure?.() ?? null,
			profile: profile.read(),
			promptPath,
		};
		const pick = pickGuidanceLesson(current, context, shown);
		if (pick === null) return [];
		if (turnsSinceTip < TURNS_BETWEEN_TIPS && pick.score < DIRECT_SCORE) return [];
		if (turnsSinceTip < 2) return [];
		const firstEver = Object.keys(context.profile.lessons).length === 0;
		shown.add(pick.lesson.id);
		turnsSinceTip = 0;
		profile.lessonShown(pick.lesson.id);
		// The transcript styles a leading [tag] as the part of Clio speaking.
		const message = firstEver
			? `[tip] ${pick.text} Tips like this come from Demo guidance in /settings, which also turns them off.`
			: `[tip] ${pick.text}`;
		return [{ kind: "notify_operator", message, key: `guidance.${pick.lesson.id}` }];
	};

	return {
		id: GUIDANCE_REGISTRATION_ID,
		description: "after a turn, show the operator one capability tip that fits the turn and what they already know",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input) {
			if (input.hook === "turn_start") {
				trackSession(input);
				turn = null;
				if (!deps.enabled() || input.metadata?.requestContinuation === true) return [];
				const prompt = (input.text ?? "").trim();
				if (prompt.length === 0) return [];
				for (const topic of harnessQuestionTopics(prompt)) profile.topic(topic);
				turn = {
					prompt,
					priorMessages: Number(input.metadata?.conversationMessages ?? 0) || 0,
					tools: new Map(),
					commands: [],
					paths: [],
					assistantChars: 0,
					toolCalls: 0,
				};
				return [];
			}
			if (turn === null) return [];
			if (input.hook === "after_tool") {
				observeTool(input, turn);
				return [];
			}
			if (input.hook === "turn_end") {
				if (!deps.enabled()) {
					turn = null;
					return [];
				}
				return finish(input);
			}
			return [];
		},
	};
}
