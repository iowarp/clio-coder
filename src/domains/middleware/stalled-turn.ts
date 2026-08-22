import type { MiddlewareRuleDefinition } from "./runtime.js";
import type { MiddlewareHookInput } from "./types.js";

export const STALLED_TURN_REGISTRATION_ID = "nudge.stalled-turn";

export const STALLED_TURN_REQUEST_CONTINUATION_MESSAGE =
	"You ended your turn after announcing an action without executing it: no tools were called. Continue now and perform the announced action, or state plainly that you are finished and waiting for the user.";

const INTENT_PATTERN = /\b(let me|i['’]ll|i will|i am going to|i['’]m going to|now i|next i|let's|let us)\b/i;

// Bare stems only. Inflected forms are derived below so that "running",
// "checking", and "verifies" count as the same announced action as "run".
const CONCRETE_ACTION_STEMS = [
	"add",
	"analyse",
	"analyze",
	"apply",
	"audit",
	"build",
	"change",
	"check",
	"compare",
	"compile",
	"create",
	"debug",
	"delete",
	"edit",
	"execute",
	"explore",
	"find",
	"fix",
	"format",
	"implement",
	"inspect",
	"install",
	"investigate",
	"list",
	"load",
	"modify",
	"open",
	"patch",
	"query",
	"read",
	"refactor",
	"remove",
	"rename",
	"replace",
	"review",
	"run",
	"scan",
	"search",
	"test",
	"trace",
	"update",
	"validate",
	"verify",
	"write",
] as const;

// Stems whose final consonant doubles before a vowel suffix.
const DOUBLED_CONSONANT_STEMS = new Set(["debug", "format", "run", "scan"]);

function concreteActionForms(stem: string): string[] {
	const forms = new Set([stem, `${stem}s`, `${stem}ed`, `${stem}ing`]);
	if (/(?:ch|sh|s|x|z)$/.test(stem)) forms.add(`${stem}es`);
	if (stem.endsWith("e")) {
		forms.add(`${stem}d`);
		forms.add(`${stem.slice(0, -1)}ing`);
	}
	if (stem.endsWith("y")) {
		forms.add(`${stem.slice(0, -1)}ies`);
		forms.add(`${stem.slice(0, -1)}ied`);
	}
	if (DOUBLED_CONSONANT_STEMS.has(stem)) {
		const doubled = `${stem}${stem.slice(-1)}`;
		forms.add(`${doubled}ed`);
		forms.add(`${doubled}ing`);
	}
	return [...forms];
}

const CONCRETE_ACTION_PATTERN = new RegExp(
	`\\b(?:${CONCRETE_ACTION_STEMS.flatMap(concreteActionForms).join("|")})\\b`,
	"giu",
);

// Extensions a model actually names when announcing work on a file. Requiring
// one (or an explicit ./, ../, ~/ prefix) keeps "and/or" and "I/O" from
// reading as paths.
const NAMED_PATH_EXTENSIONS =
	"c|cc|cfg|cjs|cmake|conf|cpp|cs|css|csv|env|go|h|hpp|html|ini|java|jl|js|json|jsx|lock|log|lua|md|mjs|nc|php|py|rb|rs|rst|sh|sql|toml|ts|tsx|txt|yaml|yml";
const NAMED_PATH_PATTERN = new RegExp(
	`(?:^|[\\s\`"'(\\[])(?:[\\w@.\\-/]*[\\w@\\-]\\.(?:${NAMED_PATH_EXTENSIONS})\\b|(?:\\.{1,2}|~)\\/[\\w@.\\-/]+)`,
	"iu",
);

// A named executable followed by at least one argument token. Words that are
// ordinary English on their own ("go", "make", "test") are deliberately absent.
const NAMED_COMMAND_PATTERN =
	/\b(?:npm|npx|pnpm|yarn|bun|git|cargo|rustc|cmake|ctest|ninja|meson|bazel|gradle|mvn|pytest|pip|python3?|node|deno|tsc|biome|eslint|prettier|jest|vitest|ruff|mypy|docker|kubectl|mpirun|srun|sbatch|gcc|clang)\s+[-\w./]/iu;

const ACTION_OBJECT_CONNECTOR_PATTERN = /^(?:at|for|in|into|on|through|to)\s+/i;
const ACTION_OBJECT_DETERMINER_PATTERN = /^(?:a|an|my|our|that|the|their|these|this|those|your)\s+/i;
const ACTION_OBJECT_PATTERN = /^(?!(?:again|everyone|later|next|now|soon|then|you)\b)[`"'./~]*[\p{L}\p{N}_-]/iu;
const CONDITIONAL_LEAD_IN_PATTERN = /\b(?:if|once|unless|until|when|whenever)\b/i;
const CONDITIONAL_INVITATION_PATTERN = /\b(?:ask|give|point|say|send|share|tell)\b[\s\S]*\b(?:and|then)\s*$/i;
// "if needed", and any conditional whose condition is about the user: "if you
// want", "if that is what you need". Conditions about the work ("if the config
// is valid") stay announcements.
const CONDITIONAL_OFFER_SUFFIX_PATTERN =
	/\b(?:if\s+(?:needed|necessary|requested)\b|if\b[^.!?]*\byou\b|when(?:ever)?\s+you\b)/i;
const LET_ME_KNOW_PATTERN = /\blet me know\b/i;
const COMPLETION_PATTERN =
	/^\s*(?:all\s+done|done|complete|completed|all\s+set)\b|^\s*(?:here(?:'s| is)\s+)?(?:a\s+)?summary\b|^\s*summary\s*:?$/i;

export const STALLED_TURN_RULE_DEFINITION: MiddlewareRuleDefinition = {
	rule: {
		id: STALLED_TURN_REGISTRATION_ID,
		source: "builtin",
		description: "request an automatic continuation when a turn announces work but calls no tools",
		enabled: true,
		hooks: ["turn_end"],
		effectKinds: ["request_continuation"],
	},
	effects: [{ kind: "request_continuation", message: STALLED_TURN_REQUEST_CONTINUATION_MESSAGE }],
	predicate: shouldRequestStalledTurnContinuation,
};

export function shouldRequestStalledTurnContinuation(input: MiddlewareHookInput): boolean {
	if (input.hook !== "turn_end") return false;
	if (input.metadata?.turnToolCalls !== 0) return false;
	if (!isNormalStopReason(input.metadata?.stopReason)) return false;

	const lastLine = lastNonEmptyLine(input.text ?? "");
	if (lastLine === null) return false;
	const finalSentence = lastSentence(lastLine);
	if (finalSentence.length === 0) return false;

	if (isQuestion(finalSentence)) return false;
	if (LET_ME_KNOW_PATTERN.test(finalSentence)) return false;
	if (COMPLETION_PATTERN.test(lastLine) || COMPLETION_PATTERN.test(finalSentence)) return false;

	return announcesConcreteAction(finalSentence);
}

function announcesConcreteAction(sentence: string): boolean {
	const intent = INTENT_PATTERN.exec(sentence);
	if (intent) {
		const leadIn = sentence.slice(0, intent.index);
		if (
			CONDITIONAL_LEAD_IN_PATTERN.test(leadIn) ||
			CONDITIONAL_INVITATION_PATTERN.test(leadIn) ||
			CONDITIONAL_OFFER_SUFFIX_PATTERN.test(sentence)
		) {
			return false;
		}
		const clause = sentence.slice(intent.index + intent[0].length);
		if (hasActionWithObject(clause)) return true;
		// A path or command is evidence of an immediate action only when the
		// announcement itself is unconditional; "once package.json is updated"
		// names a file but promises nothing now.
		if (CONDITIONAL_LEAD_IN_PATTERN.test(clause)) return false;
		return namesToolTarget(clause);
	}

	// A trailing colon can still signal a cut-off action lead-in, but only when
	// the lead-in names work and its target instead of relying on punctuation.
	return sentence.endsWith(":") && hasActionWithObject(sentence);
}

function namesToolTarget(clause: string): boolean {
	return NAMED_PATH_PATTERN.test(clause) || NAMED_COMMAND_PATTERN.test(clause);
}

function hasActionWithObject(clause: string): boolean {
	for (const action of clause.matchAll(CONCRETE_ACTION_PATTERN)) {
		const remainder = clause.slice((action.index ?? 0) + action[0].length).trimStart();
		const withoutConnector = remainder.replace(ACTION_OBJECT_CONNECTOR_PATTERN, "");
		const object = withoutConnector.replace(ACTION_OBJECT_DETERMINER_PATTERN, "");
		if (ACTION_OBJECT_PATTERN.test(object)) return true;
	}
	return false;
}

function isNormalStopReason(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value !== "string") return false;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized === "stop" || normalized === "end_turn" || normalized.startsWith("stop_sequence");
}

function lastNonEmptyLine(text: string): string | null {
	const lines = text.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim();
		if (line && line.length > 0) return line;
	}
	return null;
}

// A period only terminates a sentence when it ends a token: "bash.ts" and
// "package.json" must survive extraction intact.
const SENTENCE_TERMINATOR_PATTERN = /[.!?]+["'’)\]]*(?=\s|$)/gu;

function lastSentence(line: string): string {
	const trimmed = line.trimEnd();
	let start = 0;
	for (const terminator of trimmed.matchAll(SENTENCE_TERMINATOR_PATTERN)) {
		const end = (terminator.index ?? 0) + terminator[0].length;
		if (end >= trimmed.length) break;
		start = end;
	}
	return trimmed
		.slice(start)
		.replace(/^[\s"'([{-]+/, "")
		.trim();
}

function isQuestion(sentence: string): boolean {
	return /[?]["')\]]*$/.test(sentence.trim());
}
