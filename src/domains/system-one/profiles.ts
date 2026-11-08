/**
 * Capability profiles for served decision models, and the renderers that ask
 * them.
 *
 * A profile is a declared contract, not a measurement: which answer semantics the
 * model family may be asked, the limits its publisher declares, and how its numbers
 * are read. Every request passes through `render`, so a
 * question a profile cannot carry is abstained on before any byte leaves, and
 * an oversized option is refused rather than cut. Every typed family still speaks
 * the existing `POST /v1/systemone` wire; a model without a server for it is the
 * operator's to serve, and nothing here installs a runtime or weights. The
 * `julia-1` profile is one such case: Clio ships the client and the profile, and
 * the Julia-1 adapter that answers `systemone` for it is operator-supplied.
 *
 * Wire compatibility: the legacy request is `{state, model?, questions}` and no
 * known server is documented to ignore extra members, so the semantic kind and
 * renderer revision stay in Clio and are not sent.
 */

import { existsSync } from "node:fs";
import type { ReadoutKind, SemanticKind } from "./contract.js";
import { MAX_CHOICE_OPTIONS } from "./questions.js";
import type { EngineCapabilities, Question } from "./types.js";

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
/** Selectable on a typed-wire engine. `llm-structured` is what any chat target declares and is not chosen by hand. */
export type ProfileId = (typeof PROFILE_IDS)[number] | "llm-structured";

/** What a family declares; `engineCapabilities` adds the window of the target it runs on. */
export interface CapabilityProfile extends Omit<EngineCapabilities, "windowTokens"> {
	readonly id: ProfileId;
	/** Declared ceiling of one request's window; the target's own window applies under it. */
	readonly windowCeiling: number | null;
	/** A model tokenizer that replaces the byte proof once it is cached. Absent means the byte proof is all there is. */
	readonly tokenizer?: {
		readonly label: string;
		load(): Promise<unknown>;
		cached(): Promise<boolean>;
	};
}

const ALL_KINDS: ReadonlySet<SemanticKind> = new Set(["boolean", "exclusive", "ordinal", "independent"]);
const SERVER_READOUT: Readonly<Record<SemanticKind, ReadoutKind>> = {
	boolean: "server",
	exclusive: "server",
	ordinal: "server",
	independent: "server",
};

const LEGACY = {
	renderer: "systemone-v1",
	semantics: ALL_KINDS,
	minOptions: 1,
	maxOptions: MAX_CHOICE_OPTIONS,
	optionTokens: null,
	headTokens: null,
	windowCeiling: null,
	readout: SERVER_READOUT,
	probabilities: true,
	windowCounts: "per-question",
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
 * classification model is narrowed to those two; the dedicated English Decide
 * model is a different, larger model that its card also offers for yes/no and
 * ordinal scales. Neither declares an option bound
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
	// Nothing declares what an unnamed server's numbers are, so they do not count as real probabilities.
	generic: { id: "generic", ...LEGACY, probabilities: false },
	// The server refuses a request as a whole with HTTP 400 max_tokens_exceeded: on jev-1.14.0, 57,013
	// input tokens at 220,391 characters answered and 262,048 characters did not, each row far under the window.
	jev: { id: "jev", ...LEGACY, windowCounts: "whole-request" },
	laya: { id: "laya", ...LEGACY, windowCeiling: 512 },
	"laya-multilingual": { id: "laya-multilingual", ...LEGACY, windowCeiling: 1024 },
	"julia-1": {
		id: "julia-1",
		renderer: "julia-compact-v1",
		semantics: ALL_KINDS,
		minOptions: 2,
		maxOptions: 20,
		optionTokens: 48,
		headTokens: 512,
		windowCeiling: 8192,
		tokenizer: {
			label: "Julia-1's tokenizer",
			load: () => import("./julia-tokenizer.js").then((module) => module.loadJuliaTokenizer()),
			cached: () => import("./julia-tokenizer.js").then((module) => existsSync(module.juliaTokenizerPath())),
		},
		readout: {
			boolean: "softmax-binary",
			exclusive: "softmax-exclusive",
			ordinal: "ordinal-expectation",
			independent: "softmax-binary",
		},
		probabilities: true,
		windowCounts: "per-question",
	},
	"gliner2.5-small": {
		id: "gliner2.5-small",
		renderer: "gliner-label-v1",
		semantics: new Set<SemanticKind>(["exclusive", "independent"]),
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
		probabilities: true,
		windowCounts: "per-question",
	},
	"gliner2.5-decide": {
		id: "gliner2.5-decide",
		renderer: "gliner-label-v1",
		semantics: ALL_KINDS,
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
		probabilities: true,
		windowCounts: "per-question",
	},
	"strands-decider": {
		id: "strands-decider",
		renderer: "systemone-v1",
		semantics: ALL_KINDS,
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
		probabilities: true,
		windowCounts: "per-question",
	},
	// One schema-bound request answered with labels (`engines/llm-batch.ts`). A label has no
	// probability scale, and the prompt holds every question, so the window counts all of them.
	"llm-structured": {
		id: "llm-structured",
		renderer: "llm-prompt",
		semantics: ALL_KINDS,
		minOptions: 1,
		maxOptions: MAX_CHOICE_OPTIONS,
		optionTokens: null,
		headTokens: null,
		windowCeiling: null,
		readout: { boolean: "categorical", exclusive: "categorical", ordinal: "categorical", independent: "categorical" },
		probabilities: false,
		windowCounts: "whole-request",
	},
};

export function profileFor(id: ProfileId | undefined): CapabilityProfile {
	return PROFILES[id ?? "generic"];
}

/** What an engine on this profile declares, on a target of this window. */
export function engineCapabilities(profile: CapabilityProfile, declaredWindow: unknown): EngineCapabilities {
	const { id: _id, windowCeiling: _ceiling, tokenizer: _tokenizer, ...declared } = profile;
	return { ...declared, windowTokens: engineWindow(profile, declaredWindow) };
}

/**
 * The window one request may fill: what the target declares, bounded by the
 * profile's ceiling. Neither raises the other, and a target that declares no
 * usable window takes the ceiling. Null means no bound is known.
 */
export function engineWindow(profile: Pick<CapabilityProfile, "windowCeiling">, declared: unknown): number | null {
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

/** A counted bound: the abstain reason, null when it fits, undefined when the counter cannot decide. */
export type ExactBound = (question: Question, options: ReadonlyArray<string>) => string | null | undefined;
const exactBounds = new Map<ProfileId, ExactBound>();

/** A profile's own tokenizer, once loaded, replaces the byte proof with the model's real count. */
export function registerExactBound(id: ProfileId, bound: ExactBound): void {
	exactBounds.set(id, bound);
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
			/** `exact`: no declared bound applies. `byte-bound`: proven by UTF-8 bytes. `token-count`: counted by the model's tokenizer. */
			readonly preflight: "exact" | "byte-bound" | "token-count";
			/** True when the point's compact wording was used. */
			readonly compact: boolean;
	  }
	| { readonly abstain: string };

function bounded(
	profile: EngineCapabilities,
	question: Question,
	exactBound?: ExactBound,
): { problem: string | null; counted: boolean } {
	const texts = optionTexts(question);
	const counted = exactBound?.(question, texts);
	if (counted !== undefined) return { problem: counted, counted: true };
	if (profile.optionTokens !== null) {
		const long = texts.findIndex((text) => !fitsByteBound(text, profile.optionTokens as number));
		if (long >= 0)
			return { problem: `option ${long} cannot be proven within ${profile.optionTokens} tokens`, counted: false };
	}
	if (profile.headTokens !== null && !fitsByteBound([question.instructions, ...texts].join(" "), profile.headTokens)) {
		return { problem: `question head cannot be proven within ${profile.headTokens} tokens`, counted: false };
	}
	return { problem: null, counted: false };
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
 * One question as this family's model reads it, or the reason it must not be asked.
 * The legacy renderer and the LLM prompt are the identity. A bounded renderer prefers
 * the point's compact wording when one is given, keeps option keys and order, and
 * abstains when neither wording provably fits; it never cuts text to make it fit.
 */
export function render(
	capabilities: EngineCapabilities,
	semantic: SemanticKind,
	question: Question,
	compact?: Question,
	exactBound?: ExactBound,
): Rendered {
	if (!capabilities.semantics.has(semantic)) return { abstain: `this engine does not answer ${semantic} questions` };
	const count = optionTexts(question).length;
	if (count < capabilities.minOptions || count > capabilities.maxOptions) {
		return { abstain: `${count} options; this engine reads ${capabilities.minOptions} to ${capabilities.maxOptions}` };
	}
	if (capabilities.renderer === "systemone-v1" || capabilities.renderer === "llm-prompt") {
		return { question, preflight: "exact", compact: false };
	}
	const declared = capabilities.optionTokens !== null || capabilities.headTokens !== null;
	const preflightOf = (counted: boolean) => (!declared ? "exact" : counted ? "token-count" : "byte-bound");
	if (compact !== undefined && sameShape(question, compact)) {
		const short = compacted(compact);
		const check = bounded(capabilities, short, exactBound);
		if (check.problem === null) return { question: short, preflight: preflightOf(check.counted), compact: true };
	}
	const full = compacted(question);
	const check = bounded(capabilities, full, exactBound);
	return check.problem === null
		? { question: full, preflight: preflightOf(check.counted), compact: false }
		: { abstain: `${check.problem}; not truncated` };
}

/** The counted bound a family's tokenizer registered, if any. */
export function exactBoundFor(id: ProfileId): ExactBound | undefined {
	return exactBounds.get(id);
}
