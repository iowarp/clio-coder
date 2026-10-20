import { codexAccountScope } from "../../core/codex-account.js";
import type { CodexQuotaObservation } from "../types.js";

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** OAI-1 / #423: Pi delivers this event on both WebSocket and SSE, without a usage GET. */
export function parseCodexQuotaEvent(
	event: unknown,
	accountScope: string | null,
	nowMs = Date.now(),
): CodexQuotaObservation | null {
	const data = record(event);
	if (data?.type !== "codex.rate_limits" || accountScope === null) return null;
	const limits = record(data.rate_limits);
	if (!limits) return null;
	const windows: CodexQuotaObservation["windows"] = [];
	for (const slot of [limits.primary, limits.secondary]) {
		const raw = record(slot);
		if (
			!raw ||
			typeof raw.used_percent !== "number" ||
			!Number.isFinite(raw.used_percent) ||
			raw.used_percent < 0 ||
			raw.used_percent > 100 ||
			typeof raw.window_minutes !== "number" ||
			!Number.isFinite(raw.window_minutes) ||
			raw.window_minutes <= 0
		)
			continue;
		let resetMs = typeof raw.resets_at === "number" ? raw.resets_at * 1000 : Number.NaN;
		if (!Number.isFinite(resetMs) && typeof raw.reset_after_seconds === "number" && raw.reset_after_seconds >= 0) {
			resetMs = nowMs + raw.reset_after_seconds * 1000;
		}
		const date = new Date(resetMs);
		windows.push({
			windowMinutes: raw.window_minutes,
			usedPercent: raw.used_percent,
			resetsAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
		});
	}
	if (windows.length === 0) return null;
	const credits = record(data.credits);
	const balance = credits?.balance;
	return {
		accountScope,
		observedAt: new Date(nowMs).toISOString(),
		windows,
		plan: typeof data.plan_type === "string" && /^[a-z0-9_ -]{1,64}$/i.test(data.plan_type) ? data.plan_type : null,
		credits:
			credits && typeof credits.has_credits === "boolean" && typeof credits.unlimited === "boolean"
				? {
						hasCredits: credits.has_credits,
						unlimited: credits.unlimited,
						balance: typeof balance === "string" && /^\d+(?:\.\d+)?$/.test(balance) ? balance : null,
					}
				: null,
		allowed: typeof limits.allowed === "boolean" ? limits.allowed : null,
		limitReached: typeof limits.limit_reached === "boolean" ? limits.limit_reached : null,
	};
}

export { codexAccountScope };
