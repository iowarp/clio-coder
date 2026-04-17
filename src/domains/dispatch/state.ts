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
 */

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
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
 * spawns N concurrent `clio run` subprocesses, each of which calls ledger.persist();
 * without coordination the last writer clobbers the others and the ledger only
 * reflects one run. We serialize with an O_EXCL lockfile + bounded retry. The
 * lockfile path lives alongside runs.json so it shares the same CLIO_HOME namespace.
 */
async function withLedgerLock<T>(targetPath: string, fn: () => T | Promise<T>): Promise<T> {
	const lockPath = `${targetPath}.lock`;
	const dir = dirname(lockPath);
	mkdirSync(dir, { recursive: true });
	const deadlineMs = Date.now() + 5_000;
	let held = false;
	while (!held) {
		try {
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
			held = true;
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code !== "EEXIST") throw err;
			if (Date.now() > deadlineMs) {
				// Stale lock: best-effort cleanup and keep trying. Better to retry than
				// to wedge the ledger forever if a predecessor crashed between openSync
				// and unlinkSync. Any loss here is bounded to the runs.json file and the
				// receipts/ directory remains authoritative.
				try {
					unlinkSync(lockPath);
				} catch {
					// raced with another waiter; loop again.
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			unlinkSync(lockPath);
		} catch {
			// already gone; fine.
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
				providerId: input.providerId,
				modelId: input.modelId,
				runtime: input.runtime,
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
