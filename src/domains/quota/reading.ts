import type { Payload } from "../../core/telemetry/schemas.js";
import type { AnthropicResponseObservation, CodexQuotaObservation } from "../../engine/types.js";
import { parseAnthropicHeaders } from "./anthropic-headers.js";
import { codexStreamSnapshot } from "./observed.js";
import type { UsageWindow } from "./types.js";

export type QuotaReading = Payload<"quota.reading">;

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function readingWindows(windows: ReadonlyArray<UsageWindow>): QuotaReading["windows"] {
	return windows.flatMap((window) =>
		Number.isFinite(window.usedPct) && window.usedPct >= 0 && window.usedPct <= 100
			? [
					{
						key: window.key,
						usedPct: { kind: "measured", value: window.usedPct, source: "provider" } as const,
						...(window.resetsAt !== null && utc.test(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
					},
				]
			: [],
	);
}

/**
 * The quota a provider reported on one call, under the window keys the quota views use: Codex's codex.rate_limits
 * stream event, or Anthropic's unified rate-limit response headers. The same runtimes the session's quota views
 * read from the stream, and nothing a provider did not report (#423, #434).
 */
export function quotaReadingFromMessage(message: unknown, runtimeId: string, targetId: string): QuotaReading | null {
	const raw = (message && typeof message === "object" ? message : {}) as {
		codexQuota?: CodexQuotaObservation;
		anthropicResponse?: AnthropicResponseObservation;
	};
	let reading: QuotaReading | null = null;
	if (runtimeId === "openai-codex" && raw.codexQuota) {
		const observation = raw.codexQuota;
		const limited =
			observation.limitReached === true || observation.allowed === false
				? true
				: observation.limitReached === false || observation.allowed === true
					? false
					: undefined;
		reading = {
			provider: "codex",
			targetId,
			source: "stream-event",
			observedAt: observation.observedAt,
			windows: readingWindows(codexStreamSnapshot(observation).windows),
			...(limited === undefined ? {} : { limitReached: limited }),
		};
	} else if (runtimeId === "anthropic-max" && raw.anthropicResponse) {
		const snapshot = parseAnthropicHeaders(raw.anthropicResponse);
		const status = raw.anthropicResponse.rateLimit.status;
		if (snapshot) {
			reading = {
				provider: snapshot.providerId,
				targetId,
				source: "response-headers",
				observedAt: raw.anthropicResponse.observedAt,
				windows: readingWindows(snapshot.windows),
				...(status === undefined ? {} : { limitReached: status === "rejected" }),
			};
		}
	}
	return reading && reading.windows.length > 0 && utc.test(reading.observedAt) ? reading : null;
}

/** What makes two readings the same for the journal: usage and reset instants to the minute, which drift by seconds. */
export function quotaReadingFingerprint(reading: QuotaReading): string {
	return JSON.stringify([
		reading.limitReached ?? null,
		reading.windows.map((window) => [
			window.key,
			window.usedPct.kind === "measured" ? window.usedPct.value : null,
			window.resetsAt?.slice(0, 16) ?? null,
		]),
	]);
}
