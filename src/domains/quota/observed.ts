/**
 * The newest quota reading this process holds for each provider.
 *
 * Every surface builds its own quota service and cache, so no single cache
 * answers "what does Clio know about this account right now". Each cache
 * reports its reads here, and the background memory budget reads the result
 * without ever spending a usage read of its own. Nothing here fetches.
 */

import type { CodexQuotaObservation } from "../../engine/types.js";
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
