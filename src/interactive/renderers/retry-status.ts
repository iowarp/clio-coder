import { formatStatedWait } from "../../domains/session/retry.js";
import { truncateToWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { RetryStatusPayload } from "../../session-control/chat-loop.js";
import { ordinal } from "../status/verbs.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { modelNickname } from "../theme/labels.js";
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

/** A move is its own event, and it reads as what the operator chose. Neither side's name needs the target beside it. */
function movedRow(status: RetryStatusPayload): string {
	const named = status.movedTo && status.movedFrom && status.movedTo.modelId === status.movedFrom.modelId;
	// The same model behind another target differs only by the target, which is then the name that says anything.
	const to = status.movedTo
		? named
			? status.movedTo.targetId
			: modelNickname(status.movedTo.modelId)
		: "the new route";
	const from = status.movedFrom
		? named
			? status.movedFrom.targetId
			: modelNickname(status.movedFrom.modelId)
		: "the old route";
	return status.movedAborted === false
		? `moved to ${to} instead of waiting on ${from}`
		: `moved to ${to} · ${from} had sent no output`;
}

/** A wait the provider asked for, counted only once there is more than one. No limit applies, so none is shown. */
function waitName(status: RetryStatusPayload): string {
	const waits = status.providerWaits ?? 1;
	return `${waits > 1 ? `${ordinal(waits)} ` : ""}provider wait`;
}

/** What a settled chain went through, in the terms each part was limited by. */
function settledRetries(status: RetryStatusPayload): string {
	const waits = status.providerWaits ?? 0;
	const own = status.attempt - waits;
	if (waits === 0) return `${own} attempt${own === 1 ? "" : "s"}`;
	const waited = `${waits} provider wait${waits === 1 ? "" : "s"}`;
	return own > 0 ? `${waited} and ${own} ${own === 1 ? "retry" : "retries"}` : waited;
}

function rawRetryStatus(status: RetryStatusPayload, unbounded: boolean): string {
	if (status.phase === "moved") return movedRow(status);
	const suffix =
		status.errorMessage !== undefined && status.errorMessage.length > 0
			? `: ${unbounded ? providerErrorEvidence(status.errorMessage) : presentProviderError(status.errorMessage)}`
			: "";
	const own = `${status.attempt - (status.providerWaits ?? 0)}/${status.maxAttempts}`;
	if (status.onProviderWait === true) {
		if (status.phase === "waiting" || status.phase === "scheduled") {
			const left = status.phase === "waiting" ? (status.seconds ?? 0) * 1000 : (status.delayMs ?? 0);
			return `${waitName(status)}, next attempt in ${formatStatedWait(left)}${askedFor(status)}${suffix}`;
		}
		if (status.phase === "retrying") return `retrying after ${waitName(status)}${suffix}`;
		if (status.phase === "cancelled") return `cancelled during ${waitName(status)}${suffix}`;
	}
	if (status.phase === "waiting") {
		return `provider retry ${own} in ${formatStatedWait((status.seconds ?? 0) * 1000)}${askedFor(status)}${suffix}`;
	}
	if (status.phase === "scheduled") {
		return `provider retry ${own} in ${formatStatedWait(status.delayMs ?? 0)}${askedFor(status)}${suffix}`;
	}
	if (status.phase === "retrying") return `provider retry ${own} running${suffix}`;
	if (status.phase === "cancelled") return `provider retry cancelled (${own})${suffix}`;
	if (status.phase === "exhausted")
		return `${stoppedOnWait(status) ?? `provider retry exhausted (${status.attempt - (status.providerWaits ?? 0)})`}${suffix}`;
	return status.providerWaits
		? `recovered after ${settledRetries(status)}`
		: `provider retry recovered after ${settledRetries(status)}`;
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
