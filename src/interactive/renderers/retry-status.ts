import { truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { RetryStatusPayload } from "../../session-control/chat-loop.js";
import { retryStatusText, stoppedOnWait } from "../../session-control/retry-status-text.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { modelNickname } from "../theme/labels.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { renderNoticeRow } from "./notice.js";
import { previewBudget, previewRows } from "./preview.js";
import { presentProviderError, providerErrorEvidence } from "./provider-error.js";

const AVAILABLE_DIAGNOSTIC = /\s*\.\.\. \[available diagnostic: \/view transcript\]$/u;

/**
 * A retry-status payload as its notice text, without the mark: the `↻` in the
 * gutter already says it is a provider retry, so the text never repeats a
 * `[retry]` tag. The live line and the replayed one read identically.
 */
export function formatRetryStatus(status: RetryStatusPayload, unbounded = false): string {
	return retryStatusText(status, {
		modelName: modelNickname,
		errorText: unbounded ? providerErrorEvidence : presentProviderError,
	});
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
	if (!errorMessage) {
		return previewRows(renderNoticeRow(formatRetryStatus(heading), "retry", width), limit, width, false, "  ", 2);
	}
	// Attempts collapse into this one row while the retry is open, so the reason stays on it; the full
	// diagnostic is one /view away and a settled retry states it below.
	if (status.phase !== "cancelled" && status.phase !== "exhausted") {
		// While Clio is still retrying, advice to pick another route and resend is not yet the next step.
		const reason = presentProviderError(errorMessage, { remedyStated: true }).replace(AVAILABLE_DIAGNOSTIC, "").trim();
		// A narrow row spends itself on the reason; the composer rail states the provider's wait alongside.
		const { retryAfterMs: _asked, ...lean } = heading;
		// Two rows at most, broken between facts: one row cut the reason mid-word (`HTTP 503; mock:`) at 60 columns (N3).
		const head = formatRetryStatus(width < 90 ? lean : heading);
		const whole = renderNoticeRow(`${head} · ${reason}`, "retry", width);
		if (whole.length <= 2) return whole;
		// Past two rows the reason keeps its first sentence; the rest is evidence /view already holds.
		const first = reason.split(/(?<=\.)\s+/u)[0] ?? reason;
		const rows = renderNoticeRow(`${head} · ${first}`, "retry", width);
		if (rows.length <= 2) return rows;
		const rest = rows.slice(1).map((row) => row.replace(/^ {2}/u, ""));
		return [rows[0] ?? "", `  ${truncateToWidth(rest.join(" "), Math.max(1, width - 2), GLYPH.ellipsis)}`];
	}
	// One heading row leaves room for the failure itself, not just a View hint.
	// The diagnosis hangs in the content column beneath the mark.
	const headingRow = truncateToWidth(renderNoticeRow(formatRetryStatus(heading), "retry", width)[0] ?? "", width);
	// A stop on the wait budget states the next step in its heading, so all of it has to reach the screen.
	if (stoppedOnWait(status) !== null) return renderNoticeRow(formatRetryStatus(heading), "error", width);
	const diagnosis = presentProviderError(errorMessage);
	const inner = Math.max(1, width - 2);
	const rows = wrapTextWithAnsi(diagnosis, inner);
	if (limit === 2 && rows.length > 1) {
		const hint = " /view";
		return [
			headingRow,
			`  ${clioTheme().fg("body", truncateToWidth(`${truncateToWidth(diagnosis, Math.max(1, inner - hint.length))}${hint}`, inner))}`,
		];
	}
	return [
		headingRow,
		...previewRows(
			rows.map((row) => `  ${clioTheme().fg("body", row)}`),
			limit - 1,
			width,
			false,
			"  ",
			2,
		),
	];
}
