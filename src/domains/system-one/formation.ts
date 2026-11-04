/**
 * The one place a question becomes a request.
 *
 * Formation reads only what an engine declares. A question the engine cannot carry
 * abstains here, before any byte leaves, with a reason the caller can show. It never
 * truncates to make something fit: a state too large for the window is an overflow.
 *
 * A yes/no or a filter item goes to an engine as a yes/no when it declares independent
 * or boolean. An engine with only an exclusive choice reads it as a two-label choice
 * per item (`match` or `other`), and the mass of `match` comes back as the yes/no
 * answer, so a reader never sees the difference. One choice across all items would make
 * the items compete for mass, which a filter must not do, and an option bound would cap it.
 */

import { certaintyFromMass } from "./answers.js";
import type { SemanticKind } from "./contract.js";
import type { ExactBound } from "./profiles.js";
import { render } from "./profiles.js";
import { validateQuestion } from "./questions.js";
import type { Answer, EngineCapabilities, EngineReply, PointQuestion, Question } from "./types.js";

const MATCH = "match";
const OTHER = "other";

type RawAnswer = EngineReply["answers"][string];

export interface FormedRequest {
	readonly kind: "formed";
	readonly questions: Readonly<Record<string, Question>>;
	/** Question ids this engine will not be asked, with why. */
	readonly abstained: Readonly<Record<string, string>>;
	/** Turns one raw answer into the contract's answer. Null reads an unusable answer as an abstention. */
	decode(id: string, raw: RawAnswer): Answer | null;
}

export type Formation =
	| FormedRequest
	| { readonly kind: "refused"; readonly outcome: "unsupported" | "overflow"; readonly reason: string };

/** The same chars/4 estimate the rest of the harness budgets with. */
export function estimateTokens(value: unknown): number {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	return Math.ceil(text.length / 4);
}

function twoLabel(question: Extract<Question, { type: "noul" }>): Question {
	return {
		type: "choice",
		instructions: question.instructions,
		criteria: { [MATCH]: question.criteria.true, [OTHER]: question.criteria.false },
	};
}

/** The semantic a yes/no is asked under on this engine, or null when only a two-label choice can carry it. */
function yesNoSemantic(semantic: SemanticKind, capabilities: EngineCapabilities): SemanticKind | null {
	if (capabilities.semantics.has(semantic)) return semantic;
	if (capabilities.semantics.has("independent")) return "independent";
	if (capabilities.semantics.has("boolean")) return "boolean";
	return null;
}

function carry(
	item: PointQuestion,
	capabilities: EngineCapabilities,
	exactBound: ExactBound | undefined,
): { question: Question; semantic: SemanticKind; viaLabels: boolean } | { abstain: string } {
	const { question, compact } = item;
	if (question.type === "noul") {
		const native = yesNoSemantic(item.semantic, capabilities);
		if (native !== null) {
			const rendered = render(capabilities, native, question, compact, exactBound);
			return "abstain" in rendered ? rendered : { question: rendered.question, semantic: native, viaLabels: false };
		}
		const short = compact?.type === "noul" ? twoLabel(compact) : undefined;
		const rendered = render(capabilities, "exclusive", twoLabel(question), short, exactBound);
		return "abstain" in rendered ? rendered : { question: rendered.question, semantic: "exclusive", viaLabels: true };
	}
	const rendered = render(capabilities, item.semantic, question, compact, exactBound);
	return "abstain" in rendered ? rendered : { question: rendered.question, semantic: item.semantic, viaLabels: false };
}

function fromLabels(raw: RawAnswer): RawAnswer | null {
	if (raw.type !== "choice") return null;
	const noul = raw.probabilities?.[MATCH] ?? (raw.choice === MATCH ? 1 : 0);
	return Number.isFinite(noul) ? { type: "noul", noul } : null;
}

/** A reply is read only against what was sent, so a stray type or option never reaches a reader. */
function fitsQuestion(raw: RawAnswer, question: Question): boolean {
	if (raw.type !== question.type) return false;
	return question.type !== "choice" || (raw.choice !== undefined && Object.hasOwn(question.criteria, raw.choice));
}

/** What one engine reads of this ask, or why it reads nothing. The state and questions are already redacted. */
export function formRequest(input: {
	readonly requiresProbabilities: boolean;
	readonly state: Readonly<Record<string, unknown>>;
	readonly asked: Readonly<Record<string, PointQuestion>>;
	readonly capabilities: EngineCapabilities;
	readonly exactBound?: ExactBound | undefined;
}): Formation {
	const { state, asked, capabilities } = input;
	if (input.requiresProbabilities && !capabilities.probabilities) {
		return { kind: "refused", outcome: "unsupported", reason: "this engine does not declare real probabilities" };
	}
	const questions: Record<string, Question> = {};
	const via: Record<string, { semantic: SemanticKind; viaLabels: boolean }> = {};
	const abstained: Record<string, string> = {};
	const stateTokens = estimateTokens(state);
	const window = capabilities.windowTokens;
	const perQuestionWindow = window !== null && capabilities.windowCounts === "per-question";
	let overflowed = false;
	for (const [id, item] of Object.entries(asked)) {
		const problem = validateQuestion(item.question);
		if (problem !== null) {
			abstained[id] = problem;
			continue;
		}
		const carried = carry(item, capabilities, input.exactBound);
		if ("abstain" in carried) {
			abstained[id] = carried.abstain;
			continue;
		}
		const needed = stateTokens + estimateTokens(carried.question);
		if (perQuestionWindow && needed > window) {
			overflowed = true;
			abstained[id] = `this question needs about ${needed} tokens and the engine allows ${window}`;
			continue;
		}
		questions[id] = carried.question;
		via[id] = { semantic: carried.semantic, viaLabels: carried.viaLabels };
	}
	const carriedIds = Object.keys(questions);
	if (carriedIds.length === 0) {
		const reason = Object.values(abstained)[0] ?? "nothing to ask";
		return { kind: "refused", outcome: overflowed ? "overflow" : "unsupported", reason };
	}
	if (window !== null && capabilities.windowCounts === "whole-request") {
		const needed = carriedIds.reduce((sum, id) => sum + estimateTokens(questions[id]), stateTokens);
		if (needed > window) {
			const reason = `this request needs about ${needed} tokens and the engine allows ${window}`;
			return { kind: "refused", outcome: "overflow", reason };
		}
	}
	return {
		kind: "formed",
		questions,
		abstained,
		decode(id, raw) {
			const route = via[id];
			const question = questions[id];
			if (route === undefined || question === undefined || !fitsQuestion(raw, question)) return null;
			const shaped = route.viaLabels ? fromLabels(raw) : raw;
			if (shaped === null) return null;
			return {
				...shaped,
				certainty: certaintyFromMass(shaped.type, shaped),
				readout: capabilities.readout[route.semantic],
			};
		},
	};
}
