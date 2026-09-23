import { truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { RetryStatusPayload } from "../chat-loop.js";
import { clioTheme } from "../theme/index.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { renderNoticeRow } from "./notice.js";
import { previewBudget, previewRows } from "./preview.js";
import { presentProviderError, providerErrorEvidence } from "./provider-error.js";

function rawRetryStatus(status: RetryStatusPayload, unbounded: boolean): string {
	const showError = unbounded || (status.phase !== "waiting" && status.phase !== "retrying");
	const suffix =
		showError && status.errorMessage
			? `: ${unbounded ? providerErrorEvidence(status.errorMessage) : presentProviderError(status.errorMessage)}`
			: "";
	if (status.phase === "waiting") {
		return `provider retry ${status.attempt}/${status.maxAttempts} in ${status.seconds ?? 0}s${suffix}`;
	}
	if (status.phase === "scheduled") {
		const seconds = Math.ceil((status.delayMs ?? 0) / 1000);
		return `provider retry ${status.attempt}/${status.maxAttempts} scheduled in ${seconds}s${suffix}`;
	}
	if (status.phase === "retrying") return `provider retry ${status.attempt}/${status.maxAttempts} running${suffix}`;
	if (status.phase === "cancelled") return `provider retry cancelled (${status.attempt}/${status.maxAttempts})${suffix}`;
	if (status.phase === "exhausted") return `provider retry exhausted (${status.attempt})${suffix}`;
	return `provider retry recovered after ${status.attempt} attempt${status.attempt === 1 ? "" : "s"}`;
}

/**
 * A retry-status payload as its notice text, without the mark: the `↻` in the
 * gutter already says it is a provider retry, so the text never repeats a
 * `[retry]` tag. The live line and the replayed one read identically.
 */
export function formatRetryStatus(status: RetryStatusPayload, unbounded = false): string {
	return rawRetryStatus(status, unbounded);
}

/** Reserve diagnosis space even when a short terminal permits only two rows. */
export function renderRetryStatus(
	status: RetryStatusPayload,
	width: number,
	detail: TranscriptDetailPolicy,
	unbounded = false,
	terminalRows = 40,
): string[] {
	if (unbounded) return renderNoticeRow(formatRetryStatus(status, true), "retry", width);
	const limit = previewBudget(detail.errorRows, terminalRows);
	const { errorMessage, ...heading } = status;
	if (!errorMessage || status.phase === "waiting" || status.phase === "retrying" || status.phase === "recovered") {
		return previewRows(renderNoticeRow(formatRetryStatus(heading), "retry", width), limit, width, false, "  ", 2);
	}
	// One heading row leaves room for the failure itself, not just a View hint.
	// The diagnosis hangs in the content column beneath the mark.
	const headingRow = truncateToWidth(renderNoticeRow(formatRetryStatus(heading), "retry", width)[0] ?? "", width);
	const diagnosis = presentProviderError(errorMessage);
	const inner = Math.max(1, width - 2);
	const rows = wrapTextWithAnsi(diagnosis, inner);
	if (limit === 2 && rows.length > 1) {
		const hint = " /view";
		return [
			headingRow,
			`  ${clioTheme().fg("muted", truncateToWidth(`${truncateToWidth(diagnosis, Math.max(1, inner - hint.length))}${hint}`, inner))}`,
		];
	}
	return [
		headingRow,
		...previewRows(
			rows.map((row) => `  ${clioTheme().fg("muted", row)}`),
			limit - 1,
			width,
			false,
			"  ",
			2,
		),
	];
}
