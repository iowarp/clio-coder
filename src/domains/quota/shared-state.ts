/**
 * The quota cache's state, shared across processes in one small file under the state root.
 *
 * Every TUI, headless run and ACP server built its own in-memory quota cache, so each fresh process polled every
 * provider again and knew nothing of the 429 another process had just drawn. The file carries each provider's last
 * good reading, the failed reads being held and the endpoint holds. It is advisory: a missing, unreadable or corrupt
 * file reads as empty, which means poll, and a write lost between two processes costs one extra poll.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioStatePath, stateRootRemoved } from "../../core/xdg.js";
import type { UsageSnapshot } from "./types.js";

/** A good reading and when this machine took it. */
export interface CacheEntry {
	snapshot: UsageSnapshot;
	storedAtMs: number;
}

/** A read that did not return usage: what resolve answered, and how long to keep answering it. */
export interface MissEntry {
	answer: UsageSnapshot;
	status: UsageSnapshot["status"];
	storedAtMs: number;
	holdMs: number;
}

/** A failed read of an endpoint several adapters share, which holds that endpoint for all of them. */
export interface EndpointHold {
	storedAtMs: number;
	holdMs: number;
	message: string | null;
	retryAfterSeconds: number | null;
}

export interface SharedQuotaState {
	entries: Map<string, CacheEntry>;
	misses: Map<string, MissEntry>;
	endpoints: Map<string, EndpointHold>;
}

const VERSION = 1;
const STATUSES: ReadonlySet<string> = new Set(["ok", "no_credentials", "expired", "error", "loading"]);

/** The shared file of this CLIO Coder home; resolving it creates nothing. */
export function quotaSharedStatePath(): string {
	return join(clioStatePath(), "quota-cache.json");
}

/** Read the shared state, keeping only well-formed items; anything unreadable reads as empty. */
export function readSharedQuotaState(path: string): SharedQuotaState {
	const state: SharedQuotaState = { entries: new Map(), misses: new Map(), endpoints: new Map() };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return state;
	}
	if (!isRecord(raw) || raw.version !== VERSION) return state;
	for (const [id, value] of records(raw.entries)) {
		const snapshot = parseSnapshot(value.snapshot);
		const storedAtMs = finite(value.storedAtMs);
		if (snapshot !== null && snapshot.status === "ok" && storedAtMs !== null)
			state.entries.set(id, { snapshot, storedAtMs });
	}
	for (const [id, value] of records(raw.misses)) {
		const answer = parseSnapshot(value.answer);
		const storedAtMs = finite(value.storedAtMs);
		const holdMs = finite(value.holdMs);
		const status = value.status;
		if (answer === null || storedAtMs === null || holdMs === null || typeof status !== "string") continue;
		if (!STATUSES.has(status)) continue;
		state.misses.set(id, { answer, status: status as UsageSnapshot["status"], storedAtMs, holdMs });
	}
	for (const [endpoint, value] of records(raw.endpoints)) {
		const storedAtMs = finite(value.storedAtMs);
		const holdMs = finite(value.holdMs);
		if (storedAtMs === null || holdMs === null) continue;
		state.endpoints.set(endpoint, {
			storedAtMs,
			holdMs,
			message: typeof value.message === "string" ? value.message : null,
			retryAfterSeconds: finite(value.retryAfterSeconds),
		});
	}
	return state;
}

/** Replace the shared file. A failed write is dropped: the next process polls, as it did before the file existed. */
export function writeSharedQuotaState(path: string, state: SharedQuotaState): void {
	if (stateRootRemoved()) return;
	const document = {
		version: VERSION,
		entries: Object.fromEntries(state.entries),
		misses: Object.fromEntries(state.misses),
		endpoints: Object.fromEntries(state.endpoints),
	};
	try {
		safeResourceWrite(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
	} catch {
		return;
	}
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
