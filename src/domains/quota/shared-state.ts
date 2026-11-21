/**
 * The quota cache's state, shared across processes in one small file under the state root.
 *
 * Every TUI, headless run and ACP server built its own in-memory quota cache, so each fresh process polled every
 * provider again and knew nothing of the 429 another process had just drawn. The file carries each provider's last
 * good reading and the failed reads being held, each scoped by a fingerprint of the credential that made it, plus
 * clear stamps so a reading or hold that was superseded is never written back.
 *
 * It is advisory. A missing, unreadable or corrupt file reads as empty, which means poll. Read-merge-write runs under
 * the state file lock, and a write that finds the lock busy is skipped: losing one costs a poll, never a stale hold.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { tryWithStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStatePath, stateRootRemoved } from "../../core/xdg.js";
import { redactSecretString } from "../safety/redaction.js";
import type { UsageSnapshot } from "./types.js";

/** No hold outlives a day, whatever a header or a stored file says. */
export const QUOTA_HOLD_CAP_MS = 24 * 60 * 60_000;

/** A good reading, when it was taken, and the credential it was taken with (undefined: never shared). */
export interface CacheEntry {
	snapshot: UsageSnapshot;
	storedAtMs: number;
	scope?: string | null;
}

/** A read that did not return usage: what resolve answered, how long to keep answering it, and for which credential. */
export interface MissEntry {
	answer: UsageSnapshot;
	status: UsageSnapshot["status"];
	storedAtMs: number;
	holdMs: number;
	scope?: string | null;
}

export interface SharedQuotaState {
	entries: Map<string, CacheEntry>;
	misses: Map<string, MissEntry>;
	/** Per provider, the instant its reading and hold were last cleared; anything stamped at or before it is dead. */
	cleared: Map<string, number>;
}

const VERSION = 2;
const STATUSES: ReadonlySet<string> = new Set(["ok", "no_credentials", "expired", "error", "loading"]);

/** The shared file of this CLIO Coder home; resolving it creates nothing. */
export function quotaSharedStatePath(): string {
	return join(clioStatePath(), "quota-cache.json");
}

/**
 * Read the shared state, keeping only well-formed items. A stamp ahead of `nowMs` reads as expired and is dropped,
 * and a hold is clamped to [0, QUOTA_HOLD_CAP_MS], so no stored item can hold a provider past the cap.
 */
export function readSharedQuotaState(path: string, nowMs: number): SharedQuotaState {
	const state = emptySharedQuotaState();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return state;
	}
	if (!isRecord(raw) || raw.version !== VERSION) return state;
	const stamp = (value: unknown): number | null => {
		const at = finite(value);
		return at !== null && at <= nowMs ? at : null;
	};
	for (const [id, value] of records(raw.entries)) {
		const snapshot = parseSnapshot(value.snapshot);
		const storedAtMs = stamp(value.storedAtMs);
		const scope = parseScope(value.scope);
		if (snapshot === null || snapshot.status !== "ok" || storedAtMs === null || scope === undefined) continue;
		state.entries.set(id, { snapshot, storedAtMs, scope });
	}
	for (const [id, value] of records(raw.misses)) {
		const answer = parseSnapshot(value.answer);
		const storedAtMs = stamp(value.storedAtMs);
		const holdMs = finite(value.holdMs);
		const scope = parseScope(value.scope);
		const status = value.status;
		if (answer === null || storedAtMs === null || holdMs === null || scope === undefined) continue;
		if (typeof status !== "string" || !STATUSES.has(status)) continue;
		state.misses.set(id, {
			answer,
			status: status as UsageSnapshot["status"],
			storedAtMs,
			holdMs: Math.min(Math.max(holdMs, 0), QUOTA_HOLD_CAP_MS),
			scope,
		});
	}
	if (isRecord(raw.cleared)) {
		for (const [id, value] of Object.entries(raw.cleared)) {
			const at = stamp(value);
			if (at !== null) state.cleared.set(id, at);
		}
	}
	return state;
}

/**
 * Merge two views by stamp: the newer reading and the newer hold of each provider win, a clear stamp kills anything
 * at or before it, and a hold older than the provider's newest reading is dropped, since that reading answered it.
 */
export function mergeSharedQuotaState(left: SharedQuotaState, right: SharedQuotaState): SharedQuotaState {
	const cleared = new Map(left.cleared);
	for (const [id, at] of right.cleared) if (at > (cleared.get(id) ?? Number.NEGATIVE_INFINITY)) cleared.set(id, at);
	const alive = (id: string, at: number): boolean => at > (cleared.get(id) ?? Number.NEGATIVE_INFINITY);
	const entries = new Map<string, CacheEntry>();
	for (const id of new Set([...left.entries.keys(), ...right.entries.keys()])) {
		const entry = newer(left.entries.get(id), right.entries.get(id));
		if (entry !== undefined && alive(id, entry.storedAtMs)) entries.set(id, entry);
	}
	const misses = new Map<string, MissEntry>();
	for (const id of new Set([...left.misses.keys(), ...right.misses.keys()])) {
		const miss = newer(left.misses.get(id), right.misses.get(id));
		if (miss === undefined || !alive(id, miss.storedAtMs)) continue;
		if (miss.storedAtMs <= (entries.get(id)?.storedAtMs ?? Number.NEGATIVE_INFINITY)) continue;
		misses.set(id, miss);
	}
	return { entries, misses, cleared };
}

/**
 * Merge `local` into the shared file and write the result, under the state file lock. Returns the merged view, or null
 * when the lock was busy or the write failed; the caller then keeps its own view and the next process may poll.
 */
export function updateSharedQuotaState(path: string, local: SharedQuotaState, nowMs: number): SharedQuotaState | null {
	if (stateRootRemoved()) return null;
	try {
		const result = tryWithStateFileLockSync(path, () => {
			const merged = mergeSharedQuotaState(local, readSharedQuotaState(path, nowMs));
			writeShared(path, merged, nowMs);
			return merged;
		});
		return result.held ? result.value : null;
	} catch {
		return null;
	}
}

export function emptySharedQuotaState(): SharedQuotaState {
	return { entries: new Map(), misses: new Map(), cleared: new Map() };
}

/** Only credential-scoped items are written, holds still in force, clear stamps young enough to matter, redacted. */
function writeShared(path: string, state: SharedQuotaState, nowMs: number): void {
	const entries: Record<string, CacheEntry> = {};
	for (const [id, entry] of state.entries) {
		if (entry.scope !== undefined) entries[id] = { ...entry, snapshot: redactSnapshot(entry.snapshot) };
	}
	const misses: Record<string, MissEntry> = {};
	for (const [id, miss] of state.misses) {
		if (miss.scope === undefined || nowMs - miss.storedAtMs >= miss.holdMs) continue;
		misses[id] = { ...miss, answer: redactSnapshot(miss.answer) };
	}
	const cleared: Record<string, number> = {};
	for (const [id, at] of state.cleared) if (nowMs - at < QUOTA_HOLD_CAP_MS) cleared[id] = at;
	safeResourceWrite(path, `${JSON.stringify({ version: VERSION, entries, misses, cleared })}\n`, { mode: 0o600 });
}

/** The free-text fields of a snapshot pass through the same redaction the telemetry journal applies (reading.ts). */
function redactSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
	return {
		...snapshot,
		displayName: redactSecretString(snapshot.displayName),
		windows: snapshot.windows.map((window) => ({
			...window,
			label: redactSecretString(window.label),
			...(window.scope ? { scope: redactSecretString(window.scope) } : {}),
		})),
		...(snapshot.message ? { message: redactSecretString(snapshot.message) } : {}),
		...(snapshot.plan ? { plan: redactSecretString(snapshot.plan) } : {}),
		...(snapshot.credits
			? { credits: { ...snapshot.credits, display: redactSecretString(snapshot.credits.display) } }
			: {}),
	};
}

function newer<T extends { storedAtMs: number }>(left: T | undefined, right: T | undefined): T | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return right.storedAtMs > left.storedAtMs ? right : left;
}

/** A stored scope is a fingerprint string or null (no credential); anything else is malformed. */
function parseScope(raw: unknown): string | null | undefined {
	return raw === null || typeof raw === "string" ? raw : undefined;
}

function parseSnapshot(raw: unknown): UsageSnapshot | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.providerId !== "string" || typeof raw.displayName !== "string") return null;
	if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return null;
	if (!Array.isArray(raw.windows) || !raw.windows.every(isWindow)) return null;
	if (raw.fetchedAt !== null && typeof raw.fetchedAt !== "string") return null;
	return raw as unknown as UsageSnapshot;
}

function isWindow(raw: unknown): boolean {
	return (
		isRecord(raw) &&
		typeof raw.key === "string" &&
		typeof raw.label === "string" &&
		finite(raw.usedPct) !== null &&
		(raw.resetsAt === null || typeof raw.resetsAt === "string")
	);
}

function records(raw: unknown): Array<[string, Record<string, unknown>]> {
	if (!isRecord(raw)) return [];
	return Object.entries(raw).filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]));
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
