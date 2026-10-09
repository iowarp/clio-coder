export interface TokenSplit {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly totalTokens: number;
	/** "reported" when every contributing source reported usage; otherwise "partial" or "none". */
	readonly provenance: "reported" | "partial" | "none";
}

export function normalizeTokenUsage(raw: Record<string, unknown>) {
	const first = (...values: unknown[]): number | undefined =>
		values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
	const count = (...values: unknown[]): number => first(...values) ?? 0;
	const input = count(raw.input, raw.inputTokens, raw.input_tokens, raw.prompt_tokens);
	const output = count(raw.output, raw.outputTokens, raw.output_tokens, raw.completion_tokens);
	const cacheRead = count(raw.cacheRead, raw.cacheReadTokens, raw.cache_read_tokens);
	const cacheWrite = count(raw.cacheWrite, raw.cacheWriteTokens, raw.cache_write_tokens);
	const details = [
		raw.outputTokensDetails,
		raw.outputDetails,
		raw.output_details,
		raw.output_tokens_details,
		raw.completionTokensDetails,
		raw.completion_tokens_details,
		raw.details,
	];
	const reasoning = count(
		raw.reasoning,
		raw.reasoningTokens,
		raw.reasoning_tokens,
		...details.flatMap((value) =>
			value && typeof value === "object"
				? [(value as Record<string, unknown>).reasoningTokens, (value as Record<string, unknown>).reasoning_tokens]
				: [],
		),
	);
	const totalTokens = first(raw.totalTokens, raw.total_tokens) ?? input + output + cacheRead + cacheWrite;
	const external = raw.clioExternal as { tokenUsage?: string } | undefined;
	const observed =
		raw.estimated !== true &&
		(!external || external.tokenUsage === "provider-reported") &&
		(totalTokens > 0 || input + output + cacheRead + cacheWrite > 0);
	return {
		input: observed ? input : 0,
		output: observed ? output : 0,
		cacheRead: observed ? cacheRead : 0,
		cacheWrite: observed ? cacheWrite : 0,
		reasoning: observed ? reasoning : 0,
		totalTokens: observed ? totalTokens : 0,
		observed,
	};
}

export type NormalizedTokenUsage = ReturnType<typeof normalizeTokenUsage>;
