/**
 * A provider retry as its text, shared by the terminal's retry row and the ACP readouts. The surface passes how a
 * model id is named and, when it shows one, how a provider error reads; the engine text never carries the error.
 */

import { formatStatedWait } from "../domains/session/retry.js";
import type { RetryStatusPayload } from "./turn-recovery.js";

/** `3rd`, `11th`, `22nd`: how a count of waits reads, since a stated wait has no limit to count against. */
export function ordinal(n: number): string {
	const teens = n % 100 >= 11 && n % 100 <= 13;
	const tail = !teens && n % 10 === 1 ? "st" : !teens && n % 10 === 2 ? "nd" : !teens && n % 10 === 3 ? "rd" : "th";
	return `${n}${tail}`;
}

export interface RetryStatusTextOptions {
	modelName: (modelId: string) => string;
	errorText?: (errorMessage: string) => string;
}

/** The wait the provider named, beside the one Clio is actually sitting out. */
function askedFor(status: RetryStatusPayload): string {
	return status.retryAfterMs !== undefined ? `, provider asked to wait ${formatStatedWait(status.retryAfterMs)}` : "";
}

/** A stop on the wait budget ran out of nothing: no attempt was made, and the row says what the provider said and why. */
export function stoppedOnWait(status: RetryStatusPayload): string | null {
	if (status.waitBudgetMs === undefined || status.retryAfterMs === undefined) return null;
	const waited = status.waitedMs ? ` after waiting ${formatStatedWait(status.waitedMs)}` : "";
	return `stopped without retrying: provider asked to wait ${formatStatedWait(status.retryAfterMs)}${waited}, and Clio waits at most ${formatStatedWait(status.waitBudgetMs)} on one request · /model switches route`;
}

/** A move is its own event, and it reads as what the operator chose. Neither side's name needs the target beside it. */
function movedRow(status: RetryStatusPayload, modelName: (modelId: string) => string): string {
	const named = status.movedTo && status.movedFrom && status.movedTo.modelId === status.movedFrom.modelId;
	// The same model behind another target differs only by the target, which is then the name that says anything.
	const to = status.movedTo ? (named ? status.movedTo.targetId : modelName(status.movedTo.modelId)) : "the new route";
	const from = status.movedFrom
		? named
			? status.movedFrom.targetId
			: modelName(status.movedFrom.modelId)
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

/** The retry's text without a mark; the error suffix appears only when the surface names how errors read. */
export function retryStatusText(status: RetryStatusPayload, options: RetryStatusTextOptions): string {
	if (status.phase === "moved") return movedRow(status, options.modelName);
	const suffix =
		status.errorMessage !== undefined && status.errorMessage.length > 0 && options.errorText !== undefined
			? `: ${options.errorText(status.errorMessage)}`
			: "";
	const own = `${status.attempt - (status.providerWaits ?? 0)}/${status.maxAttempts}`;
	if (status.onProviderWait === true) {
		if (status.phase === "waiting" || status.phase === "scheduled") {
			const left = status.phase === "waiting" ? (status.seconds ?? 0) * 1000 : (status.delayMs ?? 0);
			// The rail's words: the countdown is what remains, and the provider's number is the whole wait it asked for.
			return `${waitName(status)}: will retry in ${formatStatedWait(left)}${askedFor(status)}${suffix}`;
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
