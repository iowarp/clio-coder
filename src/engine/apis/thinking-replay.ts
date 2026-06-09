/**
 * Formats thinking content for replay when the target engine does not support a native reasoning channel.
 */
export function formatThinkingForReplay(thinking: string, opts: { harmony: boolean }): string {
	if (opts.harmony) {
		// Harmony analysis-channel form extension point.
		// For v1, we use the same <think> wrapping.
		return `<think>\n${thinking.trim()}\n</think>`;
	}
	return `<think>\n${thinking.trim()}\n</think>`;
}
