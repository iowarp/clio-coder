/**
 * Prose for one expected-cold prompt-cache reason. The wire values are stamped
 * by `noteColdReason` in turn-context.ts and persisted on the assistant entry's
 * `promptCache.expectedColdReasons`. The footer notice, the Detailed receipt and
 * the context overlay all read them through this one table, and an unknown
 * reason renders as itself rather than disappearing. Each reads after "read
 * again after", in words for the operator rather than the engine's terms.
 */
export function coldReasonText(reason: string): string {
	switch (reason) {
		case "working_set_evict":
			return "trimmed tool output";
		case "compaction":
			return "a compaction";
		case "dispatch":
			return "worker traffic on the server";
		case "residency":
			return "a model reload";
		case "thinking_change":
			return "a thinking change";
		case "tool_surface_change":
			return "a tool list change";
		case "prompt_recompiled":
			return "a prompt rebuild";
		case "background_memory":
			return "a memory step on the server";
		case "model_changed":
			return "a model change";
		case "input_changed":
			return "a history rewrite";
		case "tool_choice_change":
			return "a tool choice change";
		case "transport_reset":
			return "a connection reset";
		default:
			return reason.replace(/_/gu, " ");
	}
}

/**
 * The footer notice for an expected cold prompt cache. `cache may be cold: prompt recompiled` was the engine talking to
 * itself; what the operator can use is that the next reply may be slower, and why.
 */
export function coldCacheNoticeText(reasons: ReadonlyArray<string>): string {
	return `next reply may be slower: the whole prompt is read again after ${coldReasonList(reasons)}`;
}

/** The reasons as one phrase: `a model change, a thinking change and a prompt rebuild`. */
export function coldReasonList(reasons: ReadonlyArray<string>): string {
	const words = reasons.map(coldReasonText);
	return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
