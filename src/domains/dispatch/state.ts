/**
 * Dispatch run ledger with atomic writes (Phase 6 slice 2).
 *
 * On-disk layout under `clioDataDir()`:
 *   state/runs.json              JSON array of RunEnvelope, newest first
 *   receipts/<runId>.json        per-run RunReceipt
 *
 * The ledger holds an in-memory mirror of runs.json. `create()` and `update()`
 * mutate memory only; `persist()` writes the bounded ring (default 1000, env
 * override `CLIO_MAX_RUNS`) atomically via engine.atomicWrite.
 *
 * No worker spawning, no domain wire-up, no SafeEventBus emission yet — those
 * land in P6S3 and P6S5. This slice is a pure persistence primitive.
 *
 * v0.1 known limitation: a crash between recordReceipt and persist leaves the
 * receipt JSON on disk without a ledger entry, so the orphan run does not
 * appear in listRuns(). Recovery scan at boot is tracked for v0.2 alongside
 * the full ledger replay path.
 */

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { clioDataDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import type { RunEnvelope, RunReceipt, RunStatus } from "./types.js";

const MAX_RUNS_DEFAULT = 1000;

export interface LedgerOptions {
	maxRuns?: number;
}

export type CreateRunInput = Omit<
	RunEnvelope,
	| "id"
	| "startedAt"
	| "endedAt"
	| "exitCode"
	| "status"
	| "pid"
	| "heartbeatAt"
	| "receiptPath"
	| "tokenCount"
	| "costUsd"
>;

export interface Ledger {
	create(input: CreateRunInput): RunEnvelope;
	update(id: string, patch: Partial<RunEnvelope>): RunEnvelope | null;
	get(id: string): RunEnvelope | null;
	list(opts?: { status?: RunStatus; limit?: number }): ReadonlyArray<RunEnvelope>;
	recordReceipt(id: string, receipt: RunReceipt): void;
	persist(): Promise<void>;
	reload(): void;
}

function newRunId(): string {
	const n = BigInt(`0x${randomBytes(8).toString("hex")}`);
	const raw = n.toString(36);
	if (raw.length >= 12) return raw.slice(0, 12);
	return raw.padStart(12, "0");
}

function runsPath(): string {
	return join(clioDataDir(), "state", "runs.json");
}

function receiptPathFor(runId: string): string {
	return join(clioDataDir(), "receipts", `${runId}.json`);
}

function readRuns(): RunEnvelope[] {
	const path = runsPath();
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8").trim();
	if (raw.length === 0) return [];
	const parsed = JSON.parse(raw) as RunEnvelope[];
	if (!Array.isArray(parsed)) return [];
	return parsed;
}

function resolveMaxRuns(opt: number | undefined): number {
	if (opt !== undefined && opt > 0) return Math.floor(opt);
	const envRaw = process.env.CLIO_MAX_RUNS;
	if (envRaw && envRaw.trim().length > 0) {
		const parsed = Number.parseInt(envRaw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return MAX_RUNS_DEFAULT;
}

function applyPatch(rec: RunEnvelope, patch: Partial<RunEnvelope>): RunEnvelope {
	const out: RunEnvelope = { ...rec };
	for (const key of Object.keys(patch) as Array<keyof RunEnvelope>) {
		const value = patch[key];
		if (value === undefined) continue;
		// Generic write into a strongly-typed record. Patch keys are constrained
		// by Partial<RunEnvelope>, so the value type aligns with the field type.
		(out as unknown as Record<string, unknown>)[key] = value;
	}
	return out;
}

function cloneEnvelope(envelope: RunEnvelope): RunEnvelope {
	return structuredClone(envelope);
}

/**
 * Cross-process mutex for runs.json writes. A stress harness (scripts/stress.ts)
 * spawns N concurrent `clio run` subprocesses, each of which calls
 * ledger.persist(); without coordination the last writer clobbers the others
 * and the ledger only reflects one run.
 *
 * Lock protocol:
 * 1. Each waiter opens the lockfile with O_EXCL and writes its own PID into it.
 *    A successful create + write means the waiter owns the lock.
 * 2. On EEXIST, the waiter inspects the existing lockfile: it reads the PID,
 *    checks liveness with `process.kill(pid, 0)`, and also checks the file
 *    mtime. The lock is only deleted when the owner PID is dead OR when the
 *    lockfile is older than STALE_LOCK_MS. Otherwise the waiter backs off
 *    without touching the lock. This prevents the previous behavior where
 *    two concurrent waiters would each delete each other's live lock after
 *    the acquisition deadline.
 * 3. Exponential backoff with jitter, capped at 500ms per attempt. Total
 *    deadline is 60s; after that we throw and let the caller decide. Callers
 *    that hit this limit are expected to retry at a higher level rather than
 *    corrupt ledger state by racing.
 */
const STALE_LOCK_MS = 30_000;
const ACQUIRE_DEADLINE_MS = 60_000;

function isProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		// EPERM means the PID exists but belongs to another user — still alive.
		if (e.code === "EPERM") return true;
		return false;
	}
}

function readLockPid(lockPath: string): number | null {
	try {
		const raw = readFileSync(lockPath, "utf8").trim();
		if (raw.length === 0) return null;
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}

function lockfileAgeMs(lockPath: string): number | null {
	try {
		const st = statSync(lockPath);
		return Date.now() - st.mtimeMs;
	} catch {
		return null;
	}
}

async function withLedgerLock<T>(targetPath: string, fn: () => T | Promise<T>): Promise<T> {
	const lockPath = `${targetPath}.lock`;
	const dir = dirname(lockPath);
	mkdirSync(dir, { recursive: true });
	const deadlineMs = Date.now() + ACQUIRE_DEADLINE_MS;
	let attempt = 0;
	let held = false;
	while (!held) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			held = true;
			break;
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code !== "EEXIST") throw err;

			// Existing lock — inspect ownership before touching it.
			const ownerPid = readLockPid(lockPath);
			const ageMs = lockfileAgeMs(lockPath);
			const ownerDead = ownerPid !== null && !isProcessAlive(ownerPid);
			const expired = ageMs !== null && ageMs > STALE_LOCK_MS;
			const unreadable = ownerPid === null && ageMs !== null && ageMs > STALE_LOCK_MS;

			if (ownerDead || expired || unreadable) {
				// Safe to reclaim. A concurrent waiter may win the race; that's fine,
				// our next openSync attempt will retry.
				try {
					unlinkSync(lockPath);
				} catch {
					// Another waiter cleaned it first; fall through to retry.
				}
			}

			if (Date.now() > deadlineMs) {
				throw new Error(
					`ledger lock timeout after ${ACQUIRE_DEADLINE_MS}ms at ${lockPath} (owner pid=${ownerPid ?? "?"}, age=${ageMs ?? "?"}ms)`,
				);
			}

			attempt += 1;
			const base = Math.min(500, 10 * 2 ** Math.min(attempt, 6));
			const delay = base + Math.floor(Math.random() * base);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	try {
		return await fn();
	} finally {
		// Only unlink if we still own the lock. If ours was reclaimed as stale
		// by a sibling and they now hold a fresh one, deleting here would
		// corrupt their critical section.
		const ownerPid = readLockPid(lockPath);
		if (ownerPid === process.pid) {
			try {
				unlinkSync(lockPath);
			} catch {
				// already gone; fine.
			}
		}
	}
}

function mergeRunsById(disk: RunEnvelope[], memory: RunEnvelope[]): RunEnvelope[] {
	// In-memory writes represent newer state (we just updated them in this process),
	// so they win on id conflict. Disk-only entries are preserved so sibling
	// processes' runs survive this process's persist().
	const merged = new Map<string, RunEnvelope>();
	for (const r of disk) merged.set(r.id, r);
	for (const r of memory) merged.set(r.id, r);
	const all = Array.from(merged.values());
	all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	return all;
}

export function openLedger(opts?: LedgerOptions): Ledger {
	const maxRuns = resolveMaxRuns(opts?.maxRuns);
	let runs: RunEnvelope[] = readRuns();

	function findIndex(id: string): number {
		return runs.findIndex((r) => r.id === id);
	}

	return {
		create(input: CreateRunInput): RunEnvelope {
			const envelope: RunEnvelope = {
				id: newRunId(),
				agentId: input.agentId,
				task: input.task,
				endpointId: input.endpointId,
				wireModelId: input.wireModelId,
				runtimeId: input.runtimeId,
				runtimeKind: input.runtimeKind,
				startedAt: new Date().toISOString(),
				endedAt: null,
				status: "queued",
				exitCode: null,
				pid: null,
				heartbeatAt: null,
				receiptPath: null,
				sessionId: input.sessionId,
				cwd: input.cwd,
				tokenCount: 0,
				costUsd: 0,
			};
			runs.unshift(envelope);
			return cloneEnvelope(envelope);
		},

		update(id: string, patch: Partial<RunEnvelope>): RunEnvelope | null {
			const idx = findIndex(id);
			if (idx === -1) return null;
			const current = runs[idx];
			if (!current) return null;
			const next = applyPatch(current, patch);
			runs[idx] = next;
			return cloneEnvelope(next);
		},

		get(id: string): RunEnvelope | null {
			const idx = findIndex(id);
			if (idx === -1) return null;
			const envelope = runs[idx];
			return envelope ? cloneEnvelope(envelope) : null;
		},

		list(opts?: { status?: RunStatus; limit?: number }): ReadonlyArray<RunEnvelope> {
			let filtered: RunEnvelope[] = runs;
			if (opts?.status) {
				const want = opts.status;
				filtered = filtered.filter((r) => r.status === want);
			}
			if (opts?.limit !== undefined && opts.limit >= 0) {
				filtered = filtered.slice(0, opts.limit);
			}
			return Object.freeze(filtered.map((envelope) => cloneEnvelope(envelope)));
		},

		recordReceipt(id: string, receipt: RunReceipt): void {
			const target = receiptPathFor(id);
			atomicWrite(target, JSON.stringify(receipt, null, 2));
			const idx = findIndex(id);
			if (idx !== -1) {
				const current = runs[idx];
				if (current) runs[idx] = { ...current, receiptPath: target };
			}
		},

		async persist(): Promise<void> {
			const target = runsPath();
			await withLedgerLock(target, () => {
				const diskRuns = readRuns();
				const merged = mergeRunsById(diskRuns, runs);
				const capped = merged.slice(0, maxRuns);
				runs = capped;
				atomicWrite(target, JSON.stringify(capped, null, 2));
			});
		},

		reload(): void {
			runs = readRuns();
		},
	};
}
