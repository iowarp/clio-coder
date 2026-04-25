import type { RetryStatusPayload } from "../chat-loop.js";

function shorten(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export function formatRetryStatus(status: RetryStatusPayload): string {
	const suffix = status.errorMessage ? `: ${shorten(status.errorMessage, 120)}` : "";
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
