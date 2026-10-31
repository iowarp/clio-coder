import type { EventPayload } from "../../core/telemetry/events.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { AnthropicResponseObservation, CodexQuotaObservation } from "../../engine/types.js";
import { redactSecretString } from "../safety/redaction.js";
import { parseAnthropicHeaders } from "./anthropic-headers.js";
import { codexStreamSnapshot } from "./observed.js";
import type { UsageSnapshot, UsageWindow } from "./types.js";

export type QuotaReading = EventPayload<"quota.read">;

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function readingWindows(windows: ReadonlyArray<UsageWindow>): QuotaReading["windows"] {
	return windows.flatMap((window) =>
		Number.isFinite(window.usedPct) && window.usedPct >= 0 && window.usedPct <= 100
			? [
					{
						key: window.key,
						label: redactSecretString(window.label),
						...(window.scope ? { scope: redactSecretString(window.scope) } : {}),
						usedPct: { kind: "measured", value: window.usedPct, source: "provider" } as const,
						...(window.resetsAt !== null && utc.test(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
					},
				]
			: [],
	);
}

/** Structural account facts retained for both live and journaled quota views (#434). */
export function quotaReadingFromSnapshot(snapshot: UsageSnapshot, observedAt: string): QuotaReading {
	const usedPct = snapshot.credits?.usedPct;
	const creditPct: Fact<number> =
		usedPct !== null && usedPct !== undefined && Number.isFinite(usedPct) && usedPct >= 0 && usedPct <= 100
			? { kind: "measured", value: usedPct, source: "provider" }
			: { kind: "unknown", reason: "not-observed" };
	return {
		provider: snapshot.providerId,
		targetId: snapshot.providerId,
		source: "poll",
		observedAt,
		windows: readingWindows(snapshot.windows),
		displayName: redactSecretString(snapshot.displayName),
		status: snapshot.status,
		...(snapshot.plan ? { plan: redactSecretString(snapshot.plan) } : {}),
		...(snapshot.credits
			? { credits: { display: redactSecretString(snapshot.credits.display), usedPct: creditPct } }
			: {}),
		...(snapshot.message ? { message: redactSecretString(snapshot.message) } : {}),
		...(snapshot.retryAfterSeconds !== null &&
		snapshot.retryAfterSeconds !== undefined &&
		Number.isFinite(snapshot.retryAfterSeconds) &&
		snapshot.retryAfterSeconds >= 0
			? { retryAfterSeconds: snapshot.retryAfterSeconds }
			: {}),
		...(snapshot.stale === undefined ? {} : { stale: snapshot.stale }),
	};
}

/** Failed polls are account observations too, even before the first successful reading (#434). */
export function journalPolledQuota(snapshot: UsageSnapshot, nowMs = Date.now()): boolean {
	const observedAt =
		snapshot.fetchedAt !== null && utc.test(snapshot.fetchedAt) ? snapshot.fetchedAt : new Date(nowMs).toISOString();
	return journalAccountQuota(quotaReadingFromSnapshot(snapshot, observedAt));
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
			...quotaReadingFromSnapshot(codexStreamSnapshot(observation), observation.observedAt),
			provider: "codex",
			targetId,
			source: "stream-event",
			...(limited === undefined ? {} : { limitReached: limited }),
		};
	} else if (runtimeId === "anthropic-max" && raw.anthropicResponse) {
		const snapshot = parseAnthropicHeaders(raw.anthropicResponse);
		const status = raw.anthropicResponse.rateLimit.status;
		if (snapshot) {
			reading = {
				...quotaReadingFromSnapshot(snapshot, raw.anthropicResponse.observedAt),
				targetId,
				source: "response-headers",
				...(status === undefined ? {} : { limitReached: status === "rejected" }),
			};
		}
	}
	return reading && reading.windows.length > 0 && utc.test(reading.observedAt) ? reading : null;
}

/** Window observations deduplicate drift; each fresh poll also establishes the account reading's freshness (#434). */
export function quotaReadingFingerprint(reading: QuotaReading): string {
	return JSON.stringify([
		...(reading.source === "poll" ? [reading.observedAt] : []),
		reading.limitReached ?? null,
		reading.status,
		reading.plan,
		reading.credits,
		reading.message,
		reading.retryAfterSeconds,
		reading.stale,
		reading.windows.map((window) => [
			window.key,
			window.usedPct.kind === "measured" ? window.usedPct.value : null,
			window.resetsAt?.slice(0, 16) ?? null,
		]),
	]);
}

/** The last reading the process journal holds per account, so an unchanged window is never journaled twice (#434). */
const journaledAccounts = new Map<string, string>();

/**
 * Journal a provider's quota reading in the process journal when its account's windows changed. A quota window
 * belongs to the account, not to the session whose call happened to see it, and other devices draw from it too (#434).
 */
export function journalAccountQuota(reading: QuotaReading): boolean {
	const account = JSON.stringify([reading.provider, reading.targetId]);
	const fingerprint = quotaReadingFingerprint(reading);
	if (journaledAccounts.get(account) === fingerprint) return false;
	if (!telemetryHub().emit("quota.read", reading)) return false;
	journaledAccounts.set(account, fingerprint);
	return true;
}
