import type { AnthropicResponseObservation } from "../../engine/types.js";
import { anthropicRateLimitSeverity, compareQuotaSeverity } from "./severity.js";
import type { UsageSnapshot, UsageWindow } from "./types.js";

function fraction(value: string | undefined): number | null {
	if (value === undefined || value.trim() === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function reset(value: string | undefined): string | null {
	if (value === undefined || value.trim() === "") return null;
	const milliseconds = Number(value) * 1000;
	return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15
		? new Date(milliseconds).toISOString()
		: null;
}

/** #423: inference headers include plan-specific windows absent from the OAuth usage poll. */
export function parseAnthropicHeaders(observation: AnthropicResponseObservation): UsageSnapshot | null {
	const headers = observation.rateLimit;
	if (Object.keys(headers).length === 0) return null;
	const families = new Set<string>();
	for (const key of Object.keys(headers)) {
		const match = /^(.*)-(?:utilization|reset|status|surpassed-threshold)$/.exec(key);
		if (match?.[1]) families.add(match[1]);
	}
	const overall = anthropicRateLimitSeverity(headers.status);
	const windows: UsageWindow[] = [];
	for (const family of families) {
		const utilization = fraction(headers[`${family}-utilization`]);
		if (utilization === null) continue;
		let severity = anthropicRateLimitSeverity(headers[`${family}-status`]);
		if (overall !== null && overall !== "normal" && (severity === null || compareQuotaSeverity(overall, severity) > 0))
			severity = overall;
		windows.push({
			key: family === "5h" ? "session" : family === "7d" ? "weekly" : family,
			label: family === "7d" ? "Weekly" : family,
			short: family === "7d" ? "wk" : family,
			usedPct: utilization * 100,
			resetsAt: reset(headers[`${family}-reset`]),
			...(severity === null ? {} : { severity }),
		});
	}
	windows.sort((left, right) => {
		const order: Record<string, number> = { session: 0, weekly: 1 };
		return (order[left.key] ?? 2) - (order[right.key] ?? 2) || left.key.localeCompare(right.key);
	});
	const representativeClaim = headers["representative-claim"] ?? null;
	const details = ["Inference headers", headers.status];
	const resetsAt = reset(headers.reset);
	if (resetsAt) details.push(`resets ${resetsAt}`);
	if (representativeClaim) details.push(`representative claim: ${representativeClaim}`);
	if (headers["overage-status"]) details.push(`overage: ${headers["overage-status"]}`);
	if (headers["overage-disabled-reason"]) details.push(headers["overage-disabled-reason"]);
	if (headers["fallback-percentage"]) details.push(`fallback: ${headers["fallback-percentage"]}`);
	return {
		providerId: "anthropic-max",
		displayName: "Anthropic Max",
		status: headers.status === "rejected" ? "error" : "ok",
		plan: null,
		windows,
		fetchedAt: observation.observedAt,
		retryAfterSeconds: observation.retryAfterSeconds,
		representativeClaim,
		rateLimit: { ...headers },
		message: details.filter(Boolean).join(" · "),
	};
}
