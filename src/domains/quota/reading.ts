import { createHash } from "node:crypto";
import type { EconomyUnit } from "../../core/telemetry/economy.js";
import { NATIVE_UNITS } from "../../core/telemetry/enums.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { AnthropicResponseObservation, CodexQuotaObservation } from "../../engine/types.js";
import { redactSecretString } from "../safety/redaction.js";
import { parseAnthropicHeaders } from "./anthropic-headers.js";
import { codexStreamSnapshot, STREAM_QUOTA_TTL_MS } from "./observed.js";
import { withAnthropicEvidence } from "./pool-reading.js";
import type {
	QuotaAccess,
	QuotaOverage,
	QuotaQualification,
	UsageAllowance,
	UsageSnapshot,
	UsageWindow,
} from "./types.js";

export type QuotaReading = EventPayload<"quota.read">;

/**
 * The journaled account of a call's reading: a digest of the runtime's already hashed account scope, so two accounts on
 * one target never fold into each other and the journal never holds the scope a provider request was keyed on.
 */
function readingAccount(scope: string | null | undefined): { account: string } | Record<string, never> {
	return scope ? { account: createHash("sha256").update(`quota-account\0${scope}`).digest("hex").slice(0, 16) } : {};
}

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACCESS: ReadonlySet<string> = new Set<QuotaAccess>(["allowed", "denied", "unknown"]);
const OVERAGE: ReadonlySet<string> = new Set<QuotaOverage>(["permitted", "refused", "unknown"]);
const NATIVE: ReadonlySet<string> = new Set(NATIVE_UNITS);
const POOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** A unit a provider named, as the journal accepts it; anything else is left out rather than guessed. */
function unitOf(unit: unknown): { unit: EconomyUnit } | Record<string, never> {
	return typeof unit === "string" && (NATIVE.has(unit) || /^[A-Z]{3}$/.test(unit)) ? { unit: unit as EconomyUnit } : {};
}

const QUALIFICATION: ReadonlySet<string> = new Set<QuotaQualification>([
	"authoritative",
	"advisory",
	"admission",
	"none",
]);

/** The evidence a window carries apart from its percentage. */
function windowEvidence(window: Omit<UsageWindow, "usedPct">) {
	return {
		key: window.key,
		label: redactSecretString(window.label),
		...(window.scope ? { scope: redactSecretString(window.scope) } : {}),
		...(window.resetsAt !== null && utc.test(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
		...unitOf(window.unit),
		...(Number.isSafeInteger(window.durationSeconds) && (window.durationSeconds as number) >= 1
			? { durationSeconds: window.durationSeconds as number }
			: {}),
		...(window.access !== undefined && ACCESS.has(window.access) ? { access: window.access } : {}),
		...(window.qualification !== undefined && QUALIFICATION.has(window.qualification)
			? { qualification: window.qualification }
			: {}),
	};
}

function readingWindows(
	windows: ReadonlyArray<UsageWindow>,
	allowances: ReadonlyArray<UsageAllowance> = [],
): QuotaReading["windows"] {
	return [
		...windows.flatMap((window) =>
			Number.isFinite(window.usedPct) && window.usedPct >= 0 && window.usedPct <= 100
				? [
						{
							...windowEvidence(window),
							usedPct: { kind: "measured", value: window.usedPct, source: "provider" } as const,
						},
					]
				: [],
		),
		// No authoritative pair, so no percentage: an unlimited window has none to take, any other one was not reported.
		...allowances.map((allowance) => ({
			...windowEvidence(allowance),
			usedPct: allowance.unlimited
				? ({ kind: "absent", reason: "not-applicable" } as const)
				: ({ kind: "unknown", reason: "provider-omitted" } as const),
			...(allowance.unlimited ? { unlimited: true as const } : {}),
		})),
	];
}

/**
 * Structural account facts retained for both live and journaled quota views (#434), with the pool evidence S5b adds:
 * pool pseudonym, deny status (unknown unless the adapter mapped the provider's own signal), overage, pool reset and,
 * for a fresh successful read, until when it counts as fresh (`validForMs` past `observedAt`).
 */
export function quotaReadingFromSnapshot(
	snapshot: UsageSnapshot,
	observedAt: string,
	validForMs?: number,
): QuotaReading {
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
		windows: readingWindows(snapshot.windows, snapshot.allowances),
		displayName: redactSecretString(snapshot.displayName),
		status: snapshot.status,
		...(snapshot.plan ? { plan: redactSecretString(snapshot.plan) } : {}),
		...(snapshot.credits
			? {
					credits: {
						display: redactSecretString(snapshot.credits.display),
						usedPct: creditPct,
						...unitOf(snapshot.credits.unit),
					},
				}
			: {}),
		...(snapshot.message ? { message: redactSecretString(snapshot.message) } : {}),
		...(snapshot.retryAfterSeconds !== null &&
		snapshot.retryAfterSeconds !== undefined &&
		Number.isFinite(snapshot.retryAfterSeconds) &&
		snapshot.retryAfterSeconds >= 0
			? { retryAfterSeconds: snapshot.retryAfterSeconds }
			: {}),
		...(snapshot.stale === undefined ? {} : { stale: snapshot.stale }),
		...(snapshot.accountPseudonym !== undefined && POOL.test(snapshot.accountPseudonym)
			? { accountPseudonym: snapshot.accountPseudonym }
			: {}),
		access: snapshot.access !== undefined && ACCESS.has(snapshot.access) ? snapshot.access : "unknown",
		overage: snapshot.overage !== undefined && OVERAGE.has(snapshot.overage) ? snapshot.overage : "unknown",
		...(typeof snapshot.resetsAt === "string" && utc.test(snapshot.resetsAt) ? { resetsAt: snapshot.resetsAt } : {}),
		...validUntil(snapshot, observedAt, validForMs),
	};
}

function validUntil(
	snapshot: UsageSnapshot,
	observedAt: string,
	validForMs: number | undefined,
): { validUntil: string } | Record<string, never> {
	const at = Date.parse(observedAt);
	// A rejected inference is still a successful quota observation: its stated denial is fresh evidence.
	const observed = snapshot.status === "ok" || snapshot.access === "denied";
	if (validForMs === undefined || !(validForMs > 0) || !observed || snapshot.stale === true) return {};
	const until = new Date(at + validForMs);
	return Number.isFinite(until.getTime()) ? { validUntil: until.toISOString() } : {};
}

/** Failed polls are account observations too, even before the first successful reading (#434). */
export function journalPolledQuota(snapshot: UsageSnapshot, nowMs = Date.now(), validForMs?: number): boolean {
	const observedAt =
		snapshot.fetchedAt !== null && utc.test(snapshot.fetchedAt) ? snapshot.fetchedAt : new Date(nowMs).toISOString();
	return journalAccountQuota(quotaReadingFromSnapshot(snapshot, observedAt, validForMs));
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
			...quotaReadingFromSnapshot(codexStreamSnapshot(observation), observation.observedAt, STREAM_QUOTA_TTL_MS),
			provider: "codex",
			targetId,
			source: "stream-event",
			...(limited === undefined ? {} : { limitReached: limited }),
			...readingAccount(observation.accountScope),
		};
	} else if (runtimeId === "anthropic-max" && raw.anthropicResponse) {
		const parsed = parseAnthropicHeaders(raw.anthropicResponse);
		const status = raw.anthropicResponse.rateLimit.status;
		if (parsed) {
			const snapshot = withAnthropicEvidence(parsed, raw.anthropicResponse.accountScope);
			reading = {
				...quotaReadingFromSnapshot(snapshot, raw.anthropicResponse.observedAt, STREAM_QUOTA_TTL_MS),
				targetId,
				source: "response-headers",
				...(status === undefined ? {} : { limitReached: status === "rejected" }),
				...readingAccount(raw.anthropicResponse.accountScope),
			};
		}
	}
	// A reading with no usable window still carries the provider's allow or deny status; a denial outlives its window.
	if (reading === null || !utc.test(reading.observedAt)) return null;
	if (reading.windows.length > 0) return reading;
	return reading.limitReached !== undefined || reading.access === "denied" ? { ...reading, limitOnly: true } : null;
}

/**
 * Window observations deduplicate drift; each fresh successful poll also establishes the account reading's freshness
 * (#434). A failed poll that repeats the last one (no credential, the same error) says nothing new, so it is journaled
 * once rather than on every read.
 */
export function quotaReadingFingerprint(reading: QuotaReading): string {
	return JSON.stringify([
		...(reading.source === "poll" && reading.status === "ok" ? [reading.observedAt] : []),
		reading.limitReached ?? null,
		reading.access ?? null,
		reading.overage ?? null,
		reading.accountPseudonym ?? null,
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
			window.access ?? null,
		]),
	]);
}

/** The last reading the process journal holds per account, so an unchanged window is never journaled twice (#434). */
const journaledAccounts = new Map<string, { fingerprint: string; validUntil: string | undefined }>();

/**
 * Journal a provider's quota reading in the process journal when its account's windows changed. A quota window
 * belongs to the account, not to the session whose call happened to see it, and other devices draw from it too (#434).
 */
export function journalAccountQuota(reading: QuotaReading): boolean {
	const account = JSON.stringify([reading.provider, reading.targetId, reading.account ?? null]);
	const fingerprint = quotaReadingFingerprint(reading);
	const prior = journaledAccounts.get(account);
	// An unchanged reading is journaled again once the journaled one's freshness lapsed, so the journal renews it.
	const renews =
		reading.validUntil !== undefined &&
		(prior?.validUntil === undefined || Date.parse(reading.observedAt) >= Date.parse(prior.validUntil));
	if (prior?.fingerprint === fingerprint && !renews) return false;
	if (!telemetryHub().emit("quota.read", reading)) return false;
	journaledAccounts.set(account, { fingerprint, validUntil: reading.validUntil });
	return true;
}
