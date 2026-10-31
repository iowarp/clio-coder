const TOKEN_CHARS = 4;

/** The chars/4 token estimate Clio uses wherever no tokenizer counted the text (`EstimateMethod` "chars/4"). */
export function ceilChars(chars: number): number {
	return Math.ceil(Math.max(0, chars) / TOKEN_CHARS);
}

function tokenUsageCounts(raw: Record<string, unknown>) {
	const first = (...values: unknown[]): number | undefined =>
		values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
	const count = first;
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
	return { input, output, cacheRead, cacheWrite, reasoning, totalTokens: first(raw.totalTokens, raw.total_tokens) };
}

/** Count-field presence includes reported zero; observed retains its historical positive-usage semantics (#434). */
export function hasTokenUsageCounts(raw: Record<string, unknown>): boolean {
	return Object.values(tokenUsageCounts(raw)).some((value) => value !== undefined);
}

export function normalizeTokenUsage(raw: Record<string, unknown>) {
	const counts = tokenUsageCounts(raw);
	const input = counts.input ?? 0;
	const output = counts.output ?? 0;
	const cacheRead = counts.cacheRead ?? 0;
	const cacheWrite = counts.cacheWrite ?? 0;
	const reasoning = counts.reasoning ?? 0;
	const totalTokens = counts.totalTokens ?? input + output + cacheRead + cacheWrite;
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

/** Whether a provider's response sent a cache-read count or omitted it, so an omitted zero is never measured. */
export type CacheReadField = "sent" | "omitted";

/** Per-call usage; `cacheReadField` is absent when the adapter does not check the field. */
export type CallUsage = NormalizedTokenUsage & { cacheReadField?: CacheReadField };

/** Normalize one call's usage and carry `cacheReadField` through on observed usage. */
export function normalizeCallUsage(raw: Record<string, unknown>): CallUsage {
	const usage = normalizeTokenUsage(raw);
	return usage.observed && (raw.cacheReadField === "sent" || raw.cacheReadField === "omitted")
		? { ...usage, cacheReadField: raw.cacheReadField }
		: usage;
}
