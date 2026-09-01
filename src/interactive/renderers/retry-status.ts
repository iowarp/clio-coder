import type { RetryStatusPayload } from "../chat-loop.js";
import { styleTaggedNotice } from "./notice.js";

function rawRetryStatus(status: RetryStatusPayload): string {
	// Both live and replay renderers wrap this notice to their terminal width.
	// Capping the error here discarded the remedy before either renderer saw it.
	const suffix = status.errorMessage ? `: ${status.errorMessage}` : "";
	if (status.phase === "waiting") {
		return `[retry] attempt ${status.attempt}/${status.maxAttempts} in ${status.seconds ?? 0}s${suffix}`;
	}
	if (status.phase === "scheduled") {
		const seconds = Math.ceil((status.delayMs ?? 0) / 1000);
		return `[retry] attempt ${status.attempt}/${status.maxAttempts} scheduled in ${seconds}s${suffix}`;
	}
	if (status.phase === "retrying") return `[retry] attempt ${status.attempt}/${status.maxAttempts} running${suffix}`;
	if (status.phase === "cancelled") return `[retry] cancelled attempt ${status.attempt}/${status.maxAttempts}${suffix}`;
	if (status.phase === "exhausted") return `[retry] exhausted after ${status.attempt} attempt(s)${suffix}`;
	return `[retry] recovered after ${status.attempt} attempt(s)`;
}

/**
 * Format a retry-status payload as a transcript notice. The `[retry]` tag
 * renders in warning and the body in muted via the shared notice styler, so the
 * live retry line and the replayed one read identically.
 */
export function formatRetryStatus(status: RetryStatusPayload): string {
	return styleTaggedNotice(rawRetryStatus(status));
}
