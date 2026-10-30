/**
 * The newest quota reading this process holds for each provider.
 *
 * Every surface builds its own quota service and cache, so no single cache
 * answers "what does Clio know about this account right now". Each cache
 * reports its reads here, and the background memory budget reads the result
 * without ever spending a usage read of its own. Nothing here fetches.
 */

import type { AnthropicResponseObservation, CodexQuotaObservation } from "../../engine/types.js";
import { parseAnthropicHeaders } from "./anthropic-headers.js";
import { anthropicRateLimitSeverity } from "./severity.js";
import type { UsageSnapshot } from "./types.js";
import { formatPlan } from "./types.js";

interface ObservedEntry {
	/** Last successful read, or null when every read so far failed. */
	snapshot: UsageSnapshot | null;
	storedAtMs: number;
	/** Freshness window of the cache that made the read. */
	ttlMs: number;
	/** Epoch instant a 429 from the usage endpoint said to wait until. */
	retryUntilMs: number | null;
}

/** What one provider's newest reading says, as of the instant asked about. */
export interface ObservedQuota {
	snapshot: UsageSnapshot | null;
	/** True when the reading is older than the freshness window of the cache that made it. */
	stale: boolean;
	/** ISO instant a live 429 asked callers to wait until, or null. */
	retryUntil: string | null;
}

const observed = new Map<string, ObservedEntry>();

/** Record one usage read as a cache made it. A failed read keeps the last good snapshot. */
export function noteQuotaRead(snapshot: UsageSnapshot, ttlMs: number, nowMs: number): void {
	const previous = observed.get(snapshot.providerId);
	if (snapshot.status === "ok") {
		observed.set(snapshot.providerId, { snapshot, storedAtMs: nowMs, ttlMs, retryUntilMs: null });
		return;
	}
	const retryAfterSeconds = snapshot.retryAfterSeconds;
	if (retryAfterSeconds === null || retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) return;
	const readAtMs = snapshot.fetchedAt === null ? Number.NaN : Date.parse(snapshot.fetchedAt);
	observed.set(snapshot.providerId, {
		snapshot: previous?.snapshot ?? null,
		storedAtMs: previous?.storedAtMs ?? nowMs,
		ttlMs: previous?.ttlMs ?? ttlMs,
		retryUntilMs: (Number.isFinite(readAtMs) ? readAtMs : nowMs) + retryAfterSeconds * 1000,
	});
}

/** The newest reading for one provider, or null when this process never read it. */
export function observedQuota(providerId: string, nowMs: number): ObservedQuota | null {
	return readObserved(providerId, nowMs);
}

function readObserved(key: string, nowMs: number): ObservedQuota | null {
	const entry = observed.get(key);
	if (entry === undefined) return null;
	return {
		snapshot: entry.snapshot,
		stale: entry.snapshot === null || entry.snapshot.stale === true || nowMs - entry.storedAtMs >= entry.ttlMs,
		retryUntil:
			entry.retryUntilMs !== null && entry.retryUntilMs > nowMs ? new Date(entry.retryUntilMs).toISOString() : null,
	};
}

const codexTargets = new Map<string, string>();
const STREAM_QUOTA_TTL_MS = 5 * 60_000;

const anthropicTargets = new Map<string, { key: string; authProfile: string | null }>();
const anthropicListeners = new Set<(targetId: string, snapshot: UsageSnapshot) => void>();

/** #423: consumers share observations without coupling quota storage to an operator surface. */
export function onAnthropicQuotaChange(listener: (targetId: string, snapshot: UsageSnapshot) => void): () => void {
	anthropicListeners.add(listener);
	return () => {
		anthropicListeners.delete(listener);
	};
}

/** #423: scope inference quota to the target and sanitized account, independently of sibling CLI logins. */
export function noteAnthropicStreamQuota(
	targetId: string,
	observation: AnthropicResponseObservation,
	authProfile: string | null,
): void {
	const snapshot = parseAnthropicHeaders(observation);
	const storedAtMs = Date.parse(observation.observedAt);
	if (snapshot === null || !Number.isFinite(storedAtMs)) return;
	const key = JSON.stringify(["anthropic-stream", targetId, authProfile, observation.accountScope]);
	const previous = observed.get(key);
	const previousTarget = observed.get(anthropicTargets.get(targetId)?.key ?? "");
	if (previous !== undefined && previous.storedAtMs > storedAtMs) return;
	observed.set(key, {
		snapshot,
		storedAtMs,
		ttlMs: STREAM_QUOTA_TTL_MS,
		retryUntilMs:
			snapshot.rateLimit?.status === "rejected"
				? storedAtMs + Math.max(1, observation.retryAfterSeconds ?? STREAM_QUOTA_TTL_MS / 1000) * 1000
				: null,
	});
	if (previousTarget !== undefined && previousTarget.storedAtMs > storedAtMs) return;
	anthropicTargets.set(targetId, { key, authProfile });
	if (previousTarget?.snapshot?.rateLimit?.status === snapshot.rateLimit?.status) return;
	for (const listener of anthropicListeners) {
		try {
			listener(targetId, snapshot);
		} catch {
			// #423: an operator notice cannot prevent persistence of provider evidence.
		}
	}
}

export function observedAnthropicQuota(
	targetId: string,
	nowMs: number,
	authProfile: string | null,
	accountScope?: string,
): ObservedQuota | null {
	const target = anthropicTargets.get(targetId);
	const key =
		accountScope === undefined
			? target?.authProfile === authProfile
				? target.key
				: undefined
			: JSON.stringify(["anthropic-stream", targetId, authProfile, accountScope]);
	return key === undefined ? null : readObserved(key, nowMs);
}

/** #423: only inference using the polled OAuth profile may supersede its cached usage. */
export function anthropicStreamSnapshot(nowMs = Date.now(), authProfile = "anthropic-max"): UsageSnapshot | null {
	let newest: UsageSnapshot | null = null;
	for (const { key, authProfile: observedProfile } of anthropicTargets.values()) {
		if (observedProfile !== authProfile) continue;
		const reading = readObserved(key, nowMs);
		if (reading?.stale || !reading?.snapshot) continue;
		if (newest === null || Date.parse(reading.snapshot.fetchedAt ?? "") > Date.parse(newest.fetchedAt ?? ""))
			newest = reading.snapshot;
	}
	return newest;
}

export function withAnthropicStreamSnapshot(
	snapshots: ReadonlyArray<UsageSnapshot>,
	nowMs = Date.now(),
): UsageSnapshot[] {
	const streamed = anthropicStreamSnapshot(nowMs);
	return streamed === null
		? [...snapshots]
		: [...snapshots.filter((snapshot) => snapshot.providerId !== "anthropic-max"), streamed];
}

/** #423: notices use the same provider severity as quota presentation and admission. */
export function anthropicQuotaNotice(snapshot: UsageSnapshot): { level: "warning" | "error"; message: string } | null {
	const severity = anthropicRateLimitSeverity(snapshot.rateLimit?.status);
	if (severity !== "warning" && severity !== "critical") return null;
	return {
		level: severity === "critical" ? "error" : "warning",
		message: `Anthropic Max quota: ${snapshot.message ?? snapshot.rateLimit?.status}. Background memory waits for quota to recover.`,
	};
}

function codexKey(targetId: string, accountScope: string): string {
	return JSON.stringify(["codex-stream", targetId, accountScope]);
}

/** OAI-1 / #423: keep sibling CLI reads and other target/account observations separate. */
export function noteCodexStreamQuota(targetId: string, observation: CodexQuotaObservation): void {
	const key = codexKey(targetId, observation.accountScope);
	const snapshot: UsageSnapshot = {
		providerId: "codex",
		displayName: "Codex",
		status: "ok",
		fetchedAt: observation.observedAt,
		plan: formatPlan(observation.plan),
		windows: observation.windows.map((window) => ({
			key:
				window.windowMinutes === 300
					? "session"
					: window.windowMinutes === 10_080
						? "weekly"
						: `minutes-${window.windowMinutes}`,
			label: window.windowMinutes === 300 ? "5h" : window.windowMinutes === 10_080 ? "Weekly" : `${window.windowMinutes}m`,
			usedPct: window.usedPercent,
			resetsAt: window.resetsAt,
		})),
		credits: observation.credits?.unlimited
			? { display: "Unlimited", usedPct: null }
			: observation.credits?.hasCredits && observation.credits.balance !== null
				? { display: observation.credits.balance, usedPct: null }
				: null,
	};
	observed.set(key, {
		snapshot,
		storedAtMs: Date.parse(observation.observedAt),
		ttlMs: STREAM_QUOTA_TTL_MS,
		retryUntilMs: null,
	});
	codexTargets.set(targetId, key);
}

export function observedCodexQuota(targetId: string, accountScope: string | null, nowMs: number): ObservedQuota | null {
	return accountScope === null ? null : readObserved(codexKey(targetId, accountScope), nowMs);
}

interface ObservedQuotaReading {
	snapshot: UsageSnapshot;
	stale: boolean;
	source: "poll" | "response-headers" | "stream-event";
}

/** Every reading this process holds and how it arrived, for the telemetry read model's quota view (#434 §11). */
export function observedQuotaReadings(nowMs = Date.now()): ObservedQuotaReading[] {
	const anthropicKeys = new Set([...anthropicTargets.values()].map((target) => target.key));
	const codexKeys = new Map([...codexTargets].map(([targetId, key]) => [key, targetId]));
	return [...observed.keys()].flatMap((key): ObservedQuotaReading[] => {
		const reading = readObserved(key, nowMs);
		if (!reading?.snapshot) return [];
		const codexTarget = codexKeys.get(key);
		return codexTarget === undefined
			? [
					{ snapshot: reading.snapshot, stale: reading.stale, source: anthropicKeys.has(key) ? "response-headers" : "poll" },
				]
			: [
					{
						snapshot: { ...reading.snapshot, providerId: `codex:${codexTarget}` },
						stale: reading.stale,
						source: "stream-event",
					},
				];
	});
}

/** Quota views show Clio stream accounts separately from the sibling Codex CLI login. */
export function codexStreamSnapshots(nowMs = Date.now()): UsageSnapshot[] {
	return [...codexTargets].flatMap(([targetId, key]) => {
		const reading = readObserved(key, nowMs);
		return reading?.snapshot
			? [
					{ ...reading.snapshot, providerId: `codex:${targetId}`, displayName: `Codex (${targetId})`, stale: reading.stale },
				]
			: [];
	});
}
