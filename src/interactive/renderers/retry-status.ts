import { formatStatedWait } from "../../domains/session/retry.js";
import { truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { RetryStatusPayload } from "../../session-control/chat-loop.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { renderNoticeRow } from "./notice.js";
import { previewBudget, previewRows } from "./preview.js";
import { presentProviderError, providerErrorEvidence } from "./provider-error.js";

const AVAILABLE_DIAGNOSTIC = /\s*\.\.\. \[available diagnostic: \/view transcript\]$/u;

/** The wait the provider named, beside the one Clio is actually sitting out. */
function askedFor(status: RetryStatusPayload): string {
	return status.retryAfterMs !== undefined ? ` (provider asked for ${formatStatedWait(status.retryAfterMs)})` : "";
}

/** A stop on the wait budget ran out of nothing: no attempt was made, and the row says what the provider said and why. */
function stoppedOnWait(status: RetryStatusPayload): string | null {
	if (status.waitBudgetMs === undefined || status.retryAfterMs === undefined) return null;
	const waited = status.waitedMs ? ` after waiting ${formatStatedWait(status.waitedMs)}` : "";
	return `stopped without retrying: provider asked to wait ${formatStatedWait(status.retryAfterMs)}${waited}, and Clio waits at most ${formatStatedWait(status.waitBudgetMs)} on one request · /model switches route`;
}

function rawRetryStatus(status: RetryStatusPayload, unbounded: boolean): string {
	const suffix =
		status.errorMessage !== undefined && status.errorMessage.length > 0
			? `: ${unbounded ? providerErrorEvidence(status.errorMessage) : presentProviderError(status.errorMessage)}`
			: "";
	if (status.phase === "waiting") {
		return `provider retry ${status.attempt}/${status.maxAttempts} in ${formatStatedWait((status.seconds ?? 0) * 1000)}${askedFor(status)}${suffix}`;
	}
	if (status.phase === "scheduled") {
		return `provider retry ${status.attempt}/${status.maxAttempts} in ${formatStatedWait(status.delayMs ?? 0)}${askedFor(status)}${suffix}`;
	}
	if (status.phase === "retrying") return `provider retry ${status.attempt}/${status.maxAttempts} running${suffix}`;
	if (status.phase === "cancelled") return `provider retry cancelled (${status.attempt}/${status.maxAttempts})${suffix}`;
	if (status.phase === "exhausted")
		return `${stoppedOnWait(status) ?? `provider retry exhausted (${status.attempt})`}${suffix}`;
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
		const row = renderNoticeRow(`${formatRetryStatus(width < 90 ? lean : heading)} · ${reason}`, "retry", width)[0] ?? "";
		return [truncateToWidth(row, width, GLYPH.ellipsis)];
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
