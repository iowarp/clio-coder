/**
 * Prose for one expected-cold prompt-cache reason. The wire values are stamped
 * by `noteColdReason` in turn-context.ts and persisted on the assistant entry's
 * `promptCache.expectedColdReasons`. The footer notice, the Detailed receipt and
 * the context overlay all read them through this one table, and an unknown
 * reason renders as itself rather than disappearing.
 */
export function coldReasonText(reason: string): string {
	switch (reason) {
		case "working_set_evict":
			return "working-set eviction";
		case "compaction":
			return "compaction";
		case "dispatch":
			return "dispatch traffic";
		case "residency":
			return "residency change";
		case "thinking_change":
			return "thinking-level change";
		case "tool_surface_change":
			return "tool-surface change";
		case "prompt_recompiled":
			return "prompt recompiled";
		case "background_memory":
			return "background memory step";
		case "model_changed":
			return "model change";
		case "input_changed":
			return "history rewrite";
		case "tool_choice_change":
			return "tool-choice change";
		case "transport_reset":
			return "transport reset";
		default:
			return reason.replace(/_/gu, " ");
	}
}
