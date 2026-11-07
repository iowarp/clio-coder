/**
 * Durable endpoint slot discovery.
 *
 * On-disk layout under `clioStateDir()`:
 *   endpoint-slots.json          { version: 1, endpoints: { <canonical key>: record } }
 *
 * A probe that reads a server's own parallel slot count learns a fact about a
 * machine, not about the process that asked. Holding it in memory made every
 * fresh process start ignorant, so a four-slot llama.cpp server resolved at the
 * conservative local-native default of 1 until something in that process
 * happened to probe it again. This file is what carries the count across
 * process boundaries.
 *
 * Conventions follow the rest of dispatch state (see dispatch/state.ts and
 * dispatch/assignment-store.ts): reads are lock-free and tolerate a partially
 * written or foreign-versioned file by answering empty, writes take the shared
 * cross-process `withStateFileLock` on the target path and land through the
 * canonical atomic writer.
 *
 * Three things bound what a persisted count may claim:
 *
 *   1. Age. A record older than {@link endpointSlotsTtlMs} is not returned and
 *      is pruned by the next write. A server restarted with a different
 *      `--parallel` must not keep over-admitting against yesterday's number.
 *   2. Runtime identity. The record names the runtime that observed it. A
 *      different inference server now listening on the same host and port is a
 *      different scheduler, and its predecessor's slot count says nothing about
 *      it.
 *   3. Precedence. A fresh probe in this process always outranks the record,
 *      and an explicit `maxConcurrentRequests` outranks both. See
 *      endpoint-capacity.ts.
 *
 * Reads are deliberately uncached. The file holds at most
 * MAX_ENDPOINT_SLOT_RECORDS small rows, callers read it once per capacity
 * resolution rather than once per target, and a cache keyed on mtime would
 * reintroduce exactly the kind of timing-dependent answer this file exists to
 * remove.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";

/**
 * How long a persisted slot count may answer for an endpoint nothing has
 * probed in this process. A day spans an ordinary working session while still
 * expiring across the reconfigure-and-restart cycle that changes the number.
 */
export const DEFAULT_ENDPOINT_SLOTS_TTL_MS = 24 * 60 * 60 * 1000;

export const ENDPOINT_SLOTS_TTL_ENV_VAR = "CLIO_CODER_ENDPOINT_SLOTS_TTL_MS";

/** Bounded ring. An operator's target list is small; a runaway file is not. */
const MAX_ENDPOINT_SLOT_RECORDS = 64;

export interface DiscoveredEndpointSlots {
	/** Canonical endpoint key, as produced by `canonicalEndpointKey`. */
	endpointKey: string;
	/** Runtime that observed the count. A different runtime invalidates it. */
	runtimeId: string;
	slots: number;
	observedAt: string;
}

interface EndpointSlotsFile {
	version: 1;
	endpoints: Record<string, DiscoveredEndpointSlots>;
}

export function endpointSlotsPath(): string {
	return join(clioStateDir(), "endpoint-slots.json");
}

/** env override > built-in default, mirroring core/guardrails.ts resolution order. */
export function endpointSlotsTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[ENDPOINT_SLOTS_TTL_ENV_VAR]?.trim();
	if (raw !== undefined && /^[1-9]\d*$/.test(raw)) {
		const parsed = Number(raw);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	return DEFAULT_ENDPOINT_SLOTS_TTL_MS;
}

function validRecord(key: string, value: unknown): value is DiscoveredEndpointSlots {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<DiscoveredEndpointSlots>;
	return (
		record.endpointKey === key &&
		typeof record.runtimeId === "string" &&
		record.runtimeId.length > 0 &&
		typeof record.slots === "number" &&
		Number.isInteger(record.slots) &&
		record.slots > 0 &&
		typeof record.observedAt === "string" &&
		Number.isFinite(Date.parse(record.observedAt))
	);
}

/** Every well-formed row on disk, regardless of age. */
function readRecords(): DiscoveredEndpointSlots[] {
	const path = endpointSlotsPath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as EndpointSlotsFile;
		if (parsed?.version !== 1 || typeof parsed.endpoints !== "object" || parsed.endpoints === null) return [];
		return Object.entries(parsed.endpoints)
			.filter(([key, value]) => validRecord(key, value))
			.map(([, value]) => ({ ...value }));
	} catch {
		// A truncated or hand-edited file cannot bound anything. Answering empty
		// falls back to the conservative default rather than to a guess.
		return [];
	}
}

function fresh(record: DiscoveredEndpointSlots, nowMs: number, ttlMs: number): boolean {
	const observedMs = Date.parse(record.observedAt);
	// A stamp from the future is a clock that moved, not evidence of freshness.
	return observedMs <= nowMs && nowMs - observedMs < ttlMs;
}

/**
 * The slot counts a new process may treat as priors: well-formed, and observed
 * inside the staleness bound. Keyed by canonical endpoint key.
 */
export function readDiscoveredEndpointSlots(options?: {
	nowMs?: number;
	ttlMs?: number;
}): Readonly<Record<string, DiscoveredEndpointSlots>> {
	const nowMs = options?.nowMs ?? Date.now();
	const ttlMs = options?.ttlMs ?? endpointSlotsTtlMs();
	const out: Record<string, DiscoveredEndpointSlots> = {};
	for (const record of readRecords()) {
		if (!fresh(record, nowMs, ttlMs)) continue;
		out[record.endpointKey] = record;
	}
	return Object.freeze(out);
}

function writeRecords(records: ReadonlyArray<DiscoveredEndpointSlots>): void {
	const kept = [...records]
		.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
		.slice(0, MAX_ENDPOINT_SLOT_RECORDS);
	const file: EndpointSlotsFile = {
		version: 1,
		endpoints: Object.fromEntries(kept.map((record) => [record.endpointKey, { ...record }])),
	};
	safeResourceWrite(endpointSlotsPath(), `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8" });
}

/**
 * Record what a probe just learned about one endpoint. A fresh observation
 * always replaces the stored one, including downward: a server restarted with
 * fewer slots must be able to lower its own bound.
 *
 * Never throws. Losing a capacity prior degrades a later process to the
 * conservative default; failing a probe over it would be worse.
 */
export async function recordDiscoveredEndpointSlots(
	entry: { endpointKey: string; runtimeId: string; slots: number },
	options?: { nowMs?: number; ttlMs?: number; onError?: (error: unknown) => void },
): Promise<void> {
	if (!Number.isInteger(entry.slots) || entry.slots <= 0) return;
	if (entry.endpointKey.length === 0 || entry.runtimeId.length === 0) return;
	// Checked before the lock because acquiring it recreates the state root, and
	// again under it because an uninstall can land while this call waits.
	if (stateRootRemoved()) return;
	const nowMs = options?.nowMs ?? Date.now();
	const ttlMs = options?.ttlMs ?? endpointSlotsTtlMs();
	try {
		await withStateFileLock(endpointSlotsPath(), () => {
			if (stateRootRemoved()) return;
			const kept = readRecords().filter(
				(record) => record.endpointKey !== entry.endpointKey && fresh(record, nowMs, ttlMs),
			);
			kept.push({
				endpointKey: entry.endpointKey,
				runtimeId: entry.runtimeId,
				slots: entry.slots,
				observedAt: new Date(nowMs).toISOString(),
			});
			writeRecords(kept);
		});
	} catch (error) {
		options?.onError?.(error);
	}
}
