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
