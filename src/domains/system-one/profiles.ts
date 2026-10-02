/**
 * Capability profiles for served decision models, and the renderers that ask
 * them.
 *
 * A profile is a declared contract, not a measurement: which tasks and answer
 * semantics the model family may be asked, the limits its publisher declares,
 * and how its numbers are read. Every request passes through `render`, so a
 * question a profile cannot carry is abstained on before any byte leaves, and
 * an oversized option is refused rather than cut. Every profile still speaks
 * the existing `POST /v1/systemone` wire; a model without a server for it is
 * the operator's to serve (for example the Julia adapter), and nothing here
 * installs a runtime or weights.
 *
 * Wire compatibility: the legacy request is `{state, model?, questions}` and no
 * known server is documented to ignore extra members, so the semantic question
 * id, task and renderer revision stay in Clio's record and are not sent. A
 * server that wants them needs an agreed optional request member (proposed
 * name `contract: {renderer, questions: {id: {task, kind}}}`) before Clio may
 * send it.
 */

import type { DecisionTask, ReadoutKind, RendererId, SemanticKind } from "./contract.js";
import { DECISION_TASKS, semanticKind } from "./contract.js";
import { MAX_CHOICE_OPTIONS } from "./questions.js";
import type { Question } from "./types.js";

export const PROFILE_IDS = [
	"generic",
	"jev",
	"laya",
	"laya-multilingual",
	"julia-1",
	"gliner2.5-small",
	"gliner2.5-decide",
	"strands-decider",
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export interface CapabilityProfile {
	readonly id: ProfileId;
	readonly renderer: RendererId;
	readonly tasks: ReadonlySet<DecisionTask>;
	readonly kinds: ReadonlySet<SemanticKind>;
	/** Options of one choice or levels of one score, inclusive. A noul is two. */
	readonly minOptions: number;
	readonly maxOptions: number;
	/** Declared tokens of one option's text, or null for no declared bound. */
	readonly optionTokens: number | null;
	/** Declared tokens of the question with all its options, or null. */
	readonly headTokens: number | null;
	/** Declared ceiling of one request's window; the target's own window applies under it. */
	readonly windowCeiling: number | null;
	readonly readout: Readonly<Record<SemanticKind, ReadoutKind>>;
}

const ALL_TASKS: ReadonlySet<DecisionTask> = new Set(DECISION_TASKS);
const ALL_KINDS: ReadonlySet<SemanticKind> = new Set(["boolean", "exclusive", "ordinal", "independent"]);
const SERVER_READOUT: Readonly<Record<SemanticKind, ReadoutKind>> = {
	boolean: "server",
	exclusive: "server",
	ordinal: "server",
	independent: "server",
};

const LEGACY = {
	renderer: "systemone-v1",
	tasks: ALL_TASKS,
	kinds: ALL_KINDS,
	minOptions: 1,
	maxOptions: MAX_CHOICE_OPTIONS,
	optionTokens: null,
	headTokens: null,
	windowCeiling: null,
	readout: SERVER_READOUT,
} as const;

/**
 * Laya's checkpoints read 512 (English) and 1024 (multilingual) tokens and keep
 * the head of anything longer silently. `laya` is the English checkpoint and
 * the ceiling when nobody says which is served; only `laya-multilingual` may
 * read 1024. The target's `contextWindow` (480 by default on the `systemone`
 * runtime) still governs under either ceiling.
 *
 * Julia-1 declares 2 to 20 options, 48 tokens per option, a 512-token question
 * head and an 8192-token window per question row; its published accuracy used
 * 1024, which is the operator's to set on the target. Every question is one row
 * carrying the whole state, and the model reads options as a softmax.
 *
 * GLiNER2.5 classification reads a label set as an exclusive softmax or as
 * independent sigmoids (multi-label), which are different semantics. The small
 * classification model is narrowed to label-picking and relevance; the
 * dedicated English Decide model is a different, larger model that its card
 * also offers for yes/no and ordinal scales. Neither declares an option bound
 * in its card, so none is invented here.
 *
 * The Strands Decider 2B speaks the legacy wire unchanged and reads every task.
 * Its checkpoint (`hobson_config.json`) declares `max_length` 4096 and a
 * pointer head, which scores each option from that option's own hidden state,
 * so the only option ceiling is the request schema's 255 (scores 2 to 10).
 * Its schema rejects a one-option choice; the wire answers those itself and
 * never sends them (`postSystemOne`), so the profile does not abstain on them.
 * Its fitting rule gives the question the window first, up to three quarters
 * of it, and the state the rest; past that it keeps the head of the state and
 * the tail of the question. The runner's overflow check is that rule without
 * the cuts: state plus the longest question must fit the window, or nothing is
 * sent. Probabilities are the head's softmax under a per-kind temperature, and
 * a score is the expectation over its levels.
 */
export const PROFILES: Readonly<Record<ProfileId, CapabilityProfile>> = {
	generic: { id: "generic", ...LEGACY },
	jev: { id: "jev", ...LEGACY },
	laya: { id: "laya", ...LEGACY, windowCeiling: 512 },
	"laya-multilingual": { id: "laya-multilingual", ...LEGACY, windowCeiling: 1024 },
	"julia-1": {
		id: "julia-1",
		renderer: "julia-compact-v1",
		tasks: ALL_TASKS,
		kinds: ALL_KINDS,
		minOptions: 2,
		maxOptions: 20,
		optionTokens: 48,
		headTokens: 512,
		windowCeiling: 8192,
		readout: {
			boolean: "softmax-binary",
			exclusive: "softmax-exclusive",
			ordinal: "ordinal-expectation",
			independent: "softmax-binary",
		},
	},
	"gliner2.5-small": {
		id: "gliner2.5-small",
		renderer: "gliner-label-v1",
		tasks: new Set<DecisionTask>(["intent", "recipe", "relevance", "clusterSelect"]),
		kinds: new Set<SemanticKind>(["exclusive", "independent"]),
		minOptions: 2,
		maxOptions: MAX_CHOICE_OPTIONS,
		optionTokens: null,
		headTokens: null,
		windowCeiling: null,
		readout: {
			boolean: "softmax-exclusive",
			exclusive: "softmax-exclusive",
			ordinal: "ordinal-expectation",
			independent: "sigmoid-independent",
		},
	},
	"gliner2.5-decide": {
		id: "gliner2.5-decide",
		renderer: "gliner-label-v1",
		tasks: new Set<DecisionTask>(["intent", "recipe", "relevance", "clusterSelect", "turnEnd"]),
		kinds: ALL_KINDS,
		minOptions: 2,
		maxOptions: MAX_CHOICE_OPTIONS,
		optionTokens: null,
		headTokens: null,
		windowCeiling: null,
		readout: {
			boolean: "softmax-exclusive",
			exclusive: "softmax-exclusive",
			ordinal: "ordinal-expectation",
			independent: "sigmoid-independent",
		},
	},
	"strands-decider": {
		id: "strands-decider",
		renderer: "systemone-v1",
		tasks: ALL_TASKS,
		kinds: ALL_KINDS,
		minOptions: 1,
		maxOptions: MAX_CHOICE_OPTIONS,
		optionTokens: null,
		headTokens: null,
		windowCeiling: 4096,
		readout: {
			boolean: "softmax-binary",
			exclusive: "softmax-exclusive",
			ordinal: "ordinal-expectation",
			independent: "softmax-binary",
		},
	},
};

export function profileFor(id: ProfileId | undefined): CapabilityProfile {
	return PROFILES[id ?? "generic"];
}

/**
 * The window one request may fill: what the target declares, bounded by the
 * profile's ceiling. Neither raises the other, and a target that declares no
 * usable window takes the ceiling. Null means no bound is known.
 */
export function engineWindow(profile: CapabilityProfile, declared: unknown): number | null {
	const window = typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? declared : null;
	if (profile.windowCeiling === null) return window;
	return window === null ? profile.windowCeiling : Math.min(window, profile.windowCeiling);
}

/**
 * Special tokens a bounded model adds around one option or one question head
 * (a marker and a separator), charged before the text is measured.
 */
const ENCODING_RESERVE_TOKENS = 2;

/**
 * The preflight for a declared token bound. A subword tokenizer with byte
 * fallback (SentencePiece and byte-level BPE, which Julia's mmBERT tokenizer
 * is) never emits more tokens than the text has UTF-8 bytes, so a text whose
 * bytes fit under the bound minus the reserve provably fits. A text past that
 * may still fit, but nothing here can prove it, so it is abstained on. This is
 * an upper bound, not a count: the served adapter must still encode strictly
 * and refuse what would be cut.
 */
function fitsByteBound(text: string, tokens: number): boolean {
	return Buffer.byteLength(text, "utf8") <= tokens - ENCODING_RESERVE_TOKENS;
}

function compactText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function optionTexts(question: Question): string[] {
	if (question.type === "noul") return [question.criteria.false, question.criteria.true];
	if (question.type === "choice") return Object.values(question.criteria);
	return [...question.criteria];
}

/** Whether `compact` asks the same question: same type, and the same option keys or level count. */
function sameShape(question: Question, compact: Question): boolean {
	if (question.type !== compact.type) return false;
	if (question.type === "choice" && compact.type === "choice") {
		const keys = Object.keys(question.criteria);
		const short = Object.keys(compact.criteria);
		return keys.length === short.length && keys.every((key, index) => short[index] === key);
	}
	if (question.type === "score" && compact.type === "score") return question.criteria.length === compact.criteria.length;
	return true;
}

export type Rendered =
	| {
			readonly question: Question;
			/** `exact`: no declared bound applies. `byte-bound`: proven under the bound by UTF-8 bytes. */
			readonly preflight: "exact" | "byte-bound";
			/** True when the site's compact wording was used. */
			readonly compact: boolean;
	  }
	| { readonly abstain: string };

function bounded(profile: CapabilityProfile, question: Question): string | null {
	const texts = optionTexts(question);
	if (profile.optionTokens !== null) {
		const long = texts.findIndex((text) => !fitsByteBound(text, profile.optionTokens as number));
		if (long >= 0) return `option ${long} cannot be proven within ${profile.optionTokens} tokens`;
	}
	if (profile.headTokens !== null && !fitsByteBound([question.instructions, ...texts].join(" "), profile.headTokens)) {
		return `question head cannot be proven within ${profile.headTokens} tokens`;
	}
	return null;
}

function compacted(question: Question): Question {
	const instructions = compactText(question.instructions);
	if (question.type === "noul") {
		return {
			type: "noul",
			instructions,
			criteria: { true: compactText(question.criteria.true), false: compactText(question.criteria.false) },
		};
	}
	if (question.type === "choice") {
		return {
			type: "choice",
			instructions,
			criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, text]) => [key, compactText(text)])),
		};
	}
	return { type: "score", instructions, criteria: question.criteria.map(compactText) };
}

/**
 * One question as this profile's model reads it, or the reason it must not be
 * asked. The legacy renderer is the identity, so Jev and every existing server
 * receive exactly what they did. A bounded renderer prefers the site's compact
 * wording when one is given, keeps option keys and order, and abstains when
 * neither wording provably fits; it never cuts text to make it fit.
 */
export function render(
	profile: CapabilityProfile,
	task: DecisionTask,
	question: Question,
	compact?: Question,
): Rendered {
	if (!profile.tasks.has(task)) return { abstain: `profile ${profile.id} does not answer task ${task}` };
	const kind = semanticKind(task, question.type);
	if (!profile.kinds.has(kind)) return { abstain: `profile ${profile.id} does not answer ${kind} questions` };
	const count = optionTexts(question).length;
	if (count < profile.minOptions || count > profile.maxOptions) {
		return { abstain: `${count} options; profile ${profile.id} reads ${profile.minOptions} to ${profile.maxOptions}` };
	}
	if (profile.renderer === "systemone-v1") return { question, preflight: "exact", compact: false };
	const declared = profile.optionTokens !== null || profile.headTokens !== null;
	const preflight = declared ? "byte-bound" : "exact";
	if (compact !== undefined && sameShape(question, compact)) {
		const short = compacted(compact);
		if (bounded(profile, short) === null) return { question: short, preflight, compact: true };
	}
	const full = compacted(question);
	const problem = bounded(profile, full);
	return problem === null ? { question: full, preflight, compact: false } : { abstain: `${problem}; not truncated` };
}
