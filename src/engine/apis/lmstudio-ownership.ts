/**
 * Which LM Studio instances Clio loaded, and which models a Clio process is
 * streaming on, shared by the orchestrator, its workers and separate runs.
 *
 * LM Studio keeps an explicitly loaded model until someone unloads it, and it
 * answers an oversubscribed card by offloading to CPU instead of refusing the
 * load. Ownership held in one process's memory therefore let every `clio-coder
 * run` leave its model behind, and three 27B models ended up resident on one
 * GPU. One state file per LM Studio server records each instance a Clio process
 * loaded, so the next load on that server can release Clio's earlier ones
 * whichever Clio process loaded them. A lease marks a model a live Clio process is streaming
 * on; a leased model is never released, so one process never pulls a model out
 * from under another's request.
 *
 * Every read and write is best-effort. The file is an optimization over
 * co-residency, never a precondition for a turn: an unreadable file reads as
 * empty and a lock that cannot be taken runs unlocked.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BIRTH_TOKEN_SOURCE_AVAILABLE, processAlive, processBirthToken } from "../../core/process-identity.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStatePath } from "../../core/xdg.js";
import { atomicWrite } from "../session.js";

export interface ClioLoadRecord {
	instanceId: string;
	modelKey: string;
	loadedAt: string;
}

interface ModelLease {
	id: string;
	modelKey: string;
	pid: number;
	birthToken: string | null;
	host: string;
	at: string;
}

interface OwnershipFile {
	version: 1;
	loads: ClioLoadRecord[];
	leases: ModelLease[];
}

/** Where a pid's birth token cannot be read, a lease this old no longer proves anything about pid reuse. */
const SYNTHETIC_LEASE_MAX_AGE_MS = 6 * 60 * 60_000;
const LOCK_TIMEOUT_MS = 10_000;

function ownershipPath(serverKey: string): string {
	return join(clioStatePath(), "lmstudio-ownership", `${serverKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`);
}

function readOwnership(path: string): OwnershipFile {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnershipFile>;
		return {
			version: 1,
			loads: Array.isArray(raw.loads) ? raw.loads.filter(isLoadRecord) : [],
			leases: Array.isArray(raw.leases) ? raw.leases.filter(isLease) : [],
		};
	} catch {
		// Missing or unreadable: no recorded ownership, so Clio releases nothing it cannot prove it loaded.
		return { version: 1, loads: [], leases: [] };
	}
}

function isLoadRecord(value: unknown): value is ClioLoadRecord {
	const record = value as Partial<ClioLoadRecord> | null;
	return typeof record?.instanceId === "string" && typeof record.modelKey === "string";
}

function isLease(value: unknown): value is ModelLease {
	const lease = value as Partial<ModelLease> | null;
	return (
		typeof lease?.id === "string" &&
		typeof lease.modelKey === "string" &&
		typeof lease.pid === "number" &&
		typeof lease.host === "string"
	);
}

/** Whether a lease's owner is still the process that took it. */
function leaseHeld(lease: ModelLease, nowMs: number): boolean {
	// A lease from another host is never adjudicated here: a local pid probe would inspect the wrong process.
	if (lease.host !== hostname()) return true;
	const current = processBirthToken(lease.pid);
	if (current === null || current !== lease.birthToken) return false;
	if (BIRTH_TOKEN_SOURCE_AVAILABLE) return true;
	return processAlive(lease.pid) && nowMs - Date.parse(lease.at) < SYNTHETIC_LEASE_MAX_AGE_MS;
}

async function withOwnership<T>(serverKey: string, fn: (file: OwnershipFile) => T): Promise<T> {
	const path = ownershipPath(serverKey);
	return withStateFileLock(
		path,
		() => {
			const file = readOwnership(path);
			const nowMs = Date.now();
			const liveLeases = file.leases.filter((lease) => leaseHeld(lease, nowMs));
			const before = JSON.stringify(file);
			file.leases = liveLeases;
			const result = fn(file);
			if (JSON.stringify(file) !== before) atomicWrite(path, JSON.stringify(file, null, 2));
			return result;
		},
		{ timeoutMs: LOCK_TIMEOUT_MS, onAcquireFailure: "run-unlocked" },
	);
}

async function bestEffort<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch {
		// Ownership is an optimization over co-residency; losing a record never fails a turn.
		return fallback;
	}
}

/** Record an instance this process loaded on the server. */
export function recordClioLoad(serverKey: string, instanceId: string, modelKey: string): Promise<void> {
	return bestEffort(undefined, () =>
		withOwnership(serverKey, (file) => {
			file.loads = file.loads.filter((record) => record.instanceId !== instanceId);
			file.loads.push({ instanceId, modelKey, loadedAt: new Date().toISOString() });
		}),
	);
}

/** Drop the record of an instance that is no longer resident. */
export function forgetClioLoad(serverKey: string, instanceId: string): Promise<void> {
	return bestEffort(undefined, () =>
		withOwnership(serverKey, (file) => {
			file.loads = file.loads.filter((record) => record.instanceId !== instanceId);
		}),
	);
}

/** Instances any Clio process recorded loading on the server, and the model keys a live Clio process is streaming on. */
export function clioOwnership(serverKey: string): Promise<{ loads: ClioLoadRecord[]; leased: Set<string> }> {
	return bestEffort({ loads: [], leased: new Set<string>() }, () =>
		withOwnership(serverKey, (file) => ({
			loads: [...file.loads],
			leased: new Set(file.leases.map((lease) => lease.modelKey)),
		})),
	);
}

/**
 * Mark `modelKey` as in use by this process until the returned release runs.
 * Take it while holding the residency lock, so no other process can release the
 * model between the load and the lease.
 */
export async function leaseClioModel(serverKey: string, modelKey: string): Promise<() => Promise<void>> {
	const id = randomUUID();
	await bestEffort(undefined, () =>
		withOwnership(serverKey, (file) => {
			file.leases.push({
				id,
				modelKey,
				pid: process.pid,
				birthToken: processBirthToken(),
				host: hostname(),
				at: new Date().toISOString(),
			});
		}),
	);
	let released = false;
	return () => {
		if (released) return Promise.resolve();
		released = true;
		return bestEffort(undefined, () =>
			withOwnership(serverKey, (file) => {
				file.leases = file.leases.filter((lease) => lease.id !== id);
			}),
		);
	};
}
