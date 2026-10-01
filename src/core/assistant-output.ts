function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Generated content only: tool IDs, names and message framing are prompt overhead. */
export function assistantOutputBlockChars(value: unknown): number {
	const block = record(value);
	if (!block) return typeof value === "string" ? value.length : 0;
	if (block.type === "text") return typeof block.text === "string" ? block.text.length : 0;
	if (block.type === "thinking") return typeof block.thinking === "string" ? block.thinking.length : 0;
	if (block.type !== "toolCall") return 0;
	const args = block.arguments ?? block.args ?? block.input;
	if (typeof args === "string") return args.length;
	try {
		return JSON.stringify(args)?.length ?? 0;
	} catch {
		// Malformed external arguments must not break cancellation accounting.
		return 0;
	}
}

/**
 * CLB-2: raw deltas retain escaped or not-yet-parseable arguments. The shared
 * stream boundary records their character count without changing provider
 * usage. Older records and nonstreaming adapters use their retained content.
 */
export function assistantOutputChars(message: unknown): number {
	const value = record(message);
	if (!value) return 0;
	const streamed = value.clioCoderOutputChars;
	if (typeof streamed === "number" && Number.isFinite(streamed) && streamed >= 0) return streamed;
	const payload = record(value.payload) ?? value;
	const content = payload.content;
	if (Array.isArray(content)) return content.reduce((sum, block) => sum + assistantOutputBlockChars(block), 0);
	if (typeof content === "string") return content.length;
	return (
		(typeof payload.text === "string" ? payload.text.length : 0) +
		(typeof payload.thinking === "string" ? payload.thinking.length : 0)
	);
}
