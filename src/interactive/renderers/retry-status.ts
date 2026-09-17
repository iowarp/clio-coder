import { truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { RetryStatusPayload } from "../chat-loop.js";
import { clioTheme } from "../theme/index.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { styleTaggedNotice } from "./notice.js";
import { previewBudget, previewRows } from "./preview.js";
import { presentProviderError, providerErrorEvidence } from "./provider-error.js";

function rawRetryStatus(status: RetryStatusPayload, unbounded: boolean): string {
	const showError = unbounded || (status.phase !== "waiting" && status.phase !== "retrying");
	const suffix =
		showError && status.errorMessage
			? `: ${unbounded ? providerErrorEvidence(status.errorMessage) : presentProviderError(status.errorMessage)}`
			: "";
	if (status.phase === "waiting") {
		return `[retry] provider retry ${status.attempt}/${status.maxAttempts} in ${status.seconds ?? 0}s${suffix}`;
	}
	if (status.phase === "scheduled") {
		const seconds = Math.ceil((status.delayMs ?? 0) / 1000);
		return `[retry] provider retry ${status.attempt}/${status.maxAttempts} scheduled in ${seconds}s${suffix}`;
	}
	if (status.phase === "retrying")
		return `[retry] provider retry ${status.attempt}/${status.maxAttempts} running${suffix}`;
	if (status.phase === "cancelled")
		return `[retry] provider retry cancelled (${status.attempt}/${status.maxAttempts})${suffix}`;
	if (status.phase === "exhausted") return `[retry] provider retry exhausted (${status.attempt})${suffix}`;
	return `[retry] provider retry recovered after ${status.attempt} attempt(s)`;
}

/**
 * Format a retry-status payload as a transcript notice. The `[retry]` tag
 * renders in warning and the body in muted via the shared notice styler, so the
 * live retry line and the replayed one read identically.
 */
export function formatRetryStatus(status: RetryStatusPayload, unbounded = false): string {
	return styleTaggedNotice(rawRetryStatus(status, unbounded));
}

/** Reserve diagnosis space even when a short terminal permits only two rows. */
export function renderRetryStatus(
	status: RetryStatusPayload,
	width: number,
	detail: TranscriptDetailPolicy,
	unbounded = false,
	terminalRows = 40,
): string[] {
	if (unbounded) return wrapTextWithAnsi(formatRetryStatus(status, true), width);
	const limit = previewBudget(detail.errorRows, terminalRows);
	const { errorMessage, ...heading } = status;
	if (!errorMessage || status.phase === "waiting" || status.phase === "retrying" || status.phase === "recovered") {
		return previewRows(wrapTextWithAnsi(formatRetryStatus(heading), width), limit, width);
	}
	// One heading row leaves room for the failure itself, not just a View hint.
	const headingRow = truncateToWidth(formatRetryStatus(heading), width);
	const diagnosis = presentProviderError(errorMessage);
	const rows = wrapTextWithAnsi(diagnosis, width);
	if (limit === 2 && rows.length > 1) {
		const hint = " /view";
		return [
			headingRow,
			clioTheme().fg(
				"muted",
				truncateToWidth(`${truncateToWidth(diagnosis, Math.max(1, width - hint.length))}${hint}`, width),
			),
		];
	}
	return [
		headingRow,
		...previewRows(
			rows.map((row) => clioTheme().fg("muted", row)),
			limit - 1,
			width,
		),
	];
}
