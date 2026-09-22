export interface CompleteOptions {
	prompt: string;
	n_predict?: number;
	stop?: string[];
	grammar?: string;
	json_schema?: object;
	cache_prompt?: boolean;
	signal?: AbortSignal;
}

export interface CompletionChunk {
	content: string;
	stop: boolean;
	stop_type?: "eos" | "limit" | "word" | "none";
	tokens_predicted?: number;
	tokens_evaluated?: number;
}

export interface InfillOptions extends CompleteOptions {
	input_prefix: string;
	input_suffix: string;
	input_extra?: Array<{ filename: string; text: string }>;
}

export interface EmbedResult {
	vectors: number[][];
	model: string;
	dimensions: number;
	tokensUsed?: number;
}

export interface RerankItem {
	index: number;
	score: number;
	document?: string;
}

export interface RerankResult {
	items: RerankItem[];
	model: string;
}

/**
 * One typed judgment requested from a System One model. These models do not
 * generate prose: every question names a closed answer shape up front, and the
 * model returns a distribution over it. `criteria` is what each answer means,
 * so the caller defines the scale rather than hoping a prompt implies it.
 */
export type DecisionQuestion =
	| { type: "noul"; instructions: string; criteria: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: ReadonlyArray<string> };

export interface DecisionAnswer {
	type: "noul" | "choice" | "score";
	/** Probability the statement holds, 0..1. Only on `noul`. */
	noul?: number;
	/** Winning option key. Only on `choice`. */
	choice?: string;
	/**
	 * Probability mass per outcome. `choice` keys it by option, `score` by the
	 * criteria ladder index. Absent on `noul`, where `noul` is itself the mass.
	 */
	probabilities?: Record<string, number>;
	/** Position on the criteria ladder, interpolated between indices. Only on `score`. */
	score?: number;
	/** Ladder index to its criteria label, echoed back. Only on `score`. */
	legend?: Record<string, string>;
	/**
	 * The model's own certainty, distinct from the answer. A `noul` of 0.5 with
	 * high confidence is a decided coin-flip; with low confidence it is an
	 * abstention. Callers that gate on a decision must read both.
	 */
	confidence?: number;
}

export interface DecideOptions {
	/** Evidence the questions are evaluated against. Serialized as-is when not a string. */
	state: string | object | ReadonlyArray<unknown>;
	/** Questions keyed by caller-chosen id; answers come back under the same ids. */
	questions: Record<string, DecisionQuestion>;
	/** Overrides the target's default model (e.g. `jev-preview`). */
	model?: string;
	signal?: AbortSignal;
}

export interface DecideResult {
	/** Resolved model build, e.g. `jev-1.13.0` when `jev-latest` was asked for. */
	model: string;
	answers: Record<string, DecisionAnswer>;
	tokensUsed?: { input: number; output: number };
}
