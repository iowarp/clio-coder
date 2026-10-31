/**
 * Dispatch run ledger with atomic writes.
 *
 * On-disk layout under `clioStateDir()`:
 *   runs.json                    JSON array of RunEnvelope, newest first
 *
 * The ledger holds an in-memory mirror of runs.json. `create()` and `update()`
 * mutate memory only; `persist()` writes the settings-bounded ring (default
 * 1000) atomically via safeResourceWriteAsync.
 *
 * This module owns persistence. The dispatch extension wires worker spawning,
 * cross-domain coordination, and event emission around this ledger. A finished
 * run's record is its run journal's run.settled, not a row here; a row whose
 * host died before its terminal patch persisted is settled from that record at
 * startup (orphan-recovery.ts).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveGuardrail } from "../../core/guardrails.js";
import { safeResourceWrite, safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { removeRunTelemetry } from "../telemetry/retention.js";
import type { ExecutionStepResult } from "./execution-scheduler.js";
import { removeRunFeeds } from "./run-feed.js";
import type { RunEnvelope, RunStatus } from "./types.js";

/**
 * One fleet root's durable record. Records written by earlier builds may also
 * carry `dynamicPlans`, a list of validated delegation-plan hashes nothing
 * read; it is no longer written and readers ignore it.
 */
export interface FleetRunRecord {
	version: 1;
	id: string;
	/** Workspace that launched this root; older records infer it from their runs. */
	cwd?: string;
	fleet: string;
	planHash: string;
	/** The plan hash before endpoint binding; absent on records older than resume across endpoint load. */
	planIdentityHash?: string;
	stepIds: string[];
	planSteps: unknown[];
	vars: Record<string, string>;
	startedAt: string;
	endedAt: string | null;
	resumedFrom: string | null;
	steps: Array<{ stepId: string; result: ExecutionStepResult }>;
}

export interface LedgerOptions {
	maxRuns?: number;
}

export type CreateRunInput = Omit<
	RunEnvelope,
	"version" | "id" | "startedAt" | "endedAt" | "exitCode" | "status" | "pid" | "heartbeatAt" | "tokenCount" | "costUsd"
> & { id?: string };

export interface Ledger {
	create(input: CreateRunInput): RunEnvelope;
	update(id: string, patch: Partial<RunEnvelope>): RunEnvelope | null;
	get(id: string): RunEnvelope | null;
	list(opts?: { status?: RunStatus; limit?: number }): ReadonlyArray<RunEnvelope>;
	persist(): Promise<void>;
	reload(): void;
}

export function newRunId(): string {
	const n = BigInt(`0x${randomBytes(8).toString("hex")}`);
	const raw = n.toString(36);
	if (raw.length >= 12) return raw.slice(0, 12);
	return raw.padStart(12, "0");
}

function runsPath(): string {
	return join(clioStateDir(), "runs.json");
}

function fleetRunPath(runId: string): string {
	return join(clioStateDir(), "fleet-runs", `${runId}.json`);
}

export function readFleetRun(runId: string): FleetRunRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(fleetRunPath(runId), "utf8")) as FleetRunRecord;
		return parsed.version === 1 && parsed.id === runId ? structuredClone(parsed) : null;
	} catch {
		return null;
	}
}

/**
 * Write the root record and return the exact text written, so a digest of it
 * names the bytes a reader of the file sees. The text is fixed before the first
 * await, so a caller that mutates the record afterwards does not change it.
 */
export async function writeFleetRun(record: FleetRunRecord): Promise<string> {
	const text = `${JSON.stringify(record, null, 2)}\n`;
	await atomicWrite(fleetRunPath(record.id), text);
	return text;
}

export function writeFleetRunSync(record: FleetRunRecord): string {
	const text = `${JSON.stringify(record, null, 2)}\n`;
	safeResourceWrite(fleetRunPath(record.id), text, { mode: 0o600 });
	return text;
}

/**
 * How many fleet-run records a single listing will open.
 *
 * The directory is unbounded and the newest root is only discoverable by
 * reading each record's start stamp, so a scan is the only ordering available.
 * The cap keeps that scan proportional on an installation that has accumulated
 * roots for months, at the cost of missing a root older than the cap. That is
 * the right trade for every caller here: they all want the recent end.
 */
export const MAX_FLEET_RUN_SCAN = 64;

/**
 * Durable fleet-run roots, newest start first.
 *
 * Reads defensively for the same reason {@link readFleetRun} does: one record
 * written by another build, half-written, or removed between the listing and
 * the open must cost that root its row, never the whole listing.
 */
export function listFleetRuns(limit = MAX_FLEET_RUN_SCAN): FleetRunRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(join(clioStateDir(), "fleet-runs"));
	} catch {
		return [];
	}
	const records: FleetRunRecord[] = [];
	// Filter before capping: every root keeps an `.events.ndjson` journal beside
	// its record, and those entries must not spend the scan budget.
	const names = entries.filter((name) => name.endsWith(".json")).slice(0, MAX_FLEET_RUN_SCAN);
	for (const name of names) {
		const record = readFleetRun(name.slice(0, -".json".length));
		if (record !== null) records.push(record);
	}
	records.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
	return records.slice(0, Math.max(0, limit));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `RunEnvelope.heartbeatAt` deliberately persists only the absolute wall-clock
// anchor used for operator display and crash recovery. The monotonic heartbeat
// stamp belongs to the live transport in this process; serializing it would
// give a restarted process a number from an origin it cannot share.
function readRuns(): RunEnvelope[] {
	const path = runsPath();
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8").trim();
	if (raw.length === 0) return [];
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) return [];
	const envelopes: RunEnvelope[] = [];
	for (const entry of parsed) {
		if (!isRecord(entry)) continue;
		const version = entry.version === undefined ? 1 : entry.version;
		if (version !== 1) continue;
		envelopes.push({ ...(entry as unknown as RunEnvelope), version: 1 });
	}
	return envelopes;
}

function resolveMaxRuns(opt?: number | undefined): number {
	if (opt !== undefined && opt > 0) return Math.floor(opt);
	return resolveGuardrail("maxDispatchRuns");
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
 * Only a row this process actually wrote is newer than disk. The mirror also
 * holds rows read at open time that belong to sibling processes, and letting
 * those win reverted a sibling's settled run to the snapshot this process
 * happened to read: a dispatch that finished `completed`/0 reappeared as
 * `running` with a null receiptPath, and the next recovery pass then sealed it
 * `dead`/1. So memory wins only for `dirty` ids; every other id takes the disk
 * copy. A non-dirty mirror row absent from disk was evicted by a sibling's ring
 * cap and stays evicted rather than being resurrected on every persist.
 */
function mergeRunsById(disk: RunEnvelope[], memory: RunEnvelope[], dirty: ReadonlySet<string>): RunEnvelope[] {
	const merged = new Map<string, RunEnvelope>();
	for (const r of disk) merged.set(r.id, r);
	for (const r of memory) {
		if (!dirty.has(r.id)) continue;
		merged.set(r.id, r);
	}
	const all = Array.from(merged.values());
	all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	return all;
}

/**
 * Ring eviction takes finished rows only. Rows sort `startedAt` DESC, so a run
 * that has been executing for hours sits at the bottom and a plain
 * `slice(0, maxRuns)` drops the process's own live state while maxRuns newer,
 * already-finished rows survive. Live rows (`endedAt === null`) are therefore
 * kept unconditionally and the cap is spent on the finished remainder. Order
 * inside the kept set is unchanged, still `startedAt` DESC.
 */
function capRuns(all: RunEnvelope[], maxRuns: number): RunEnvelope[] {
	if (all.length <= maxRuns) return all;
	const live = all.filter((r) => r.endedAt === null);
	if (live.length === 0) return all.slice(0, maxRuns);
	let finishedBudget = Math.max(0, maxRuns - live.length);
	const kept: RunEnvelope[] = [];
	for (const run of all) {
		if (run.endedAt === null) {
			kept.push(run);
			continue;
		}
		if (finishedBudget === 0) continue;
		finishedBudget -= 1;
		kept.push(run);
	}
	return kept;
}

/**
 * persist() holds the runs.json lock across an awaited fsync, and a waiter in
 * this process polled that lock with backoff, so one ledger's write could
 * stall a sibling dispatch's for far longer than the write itself (#428).
 * Persists in this process queue here and take the file lock in turn.
 */
let queuedPersist: Promise<unknown> = Promise.resolve();
function withRunsLock(target: string, fn: () => Promise<void>): Promise<void> {
	// Checked again after the queue wait, since acquiring the lock mkdirs the root.
	const run = queuedPersist.then(() => (stateRootRemoved() ? undefined : withStateFileLock(target, fn)));
	queuedPersist = run.catch(() => {});
	return run;
}

export function openLedger(opts?: LedgerOptions): Ledger {
	let runs: RunEnvelope[] = readRuns();
	// Ids this process has written since the last successful persist. See
	// mergeRunsById: this is what separates our writes from a sibling's rows we
	// merely read at open time.
	const dirty = new Set<string>();

	function findIndex(id: string): number {
		return runs.findIndex((r) => r.id === id);
	}

	return {
		create(input: CreateRunInput): RunEnvelope {
			const envelope: RunEnvelope = {
				version: 1,
				id: input.id ?? newRunId(),
				agentId: input.agentId,
				executionRole: input.executionRole,
				...(input.agentAudience !== undefined ? { agentAudience: input.agentAudience } : {}),
				...(input.requestOrigin !== undefined ? { requestOrigin: input.requestOrigin } : {}),
				task: input.task,
				...(input.projection !== undefined ? { projection: structuredClone(input.projection) } : {}),
				...(input.budget !== undefined ? { budget: structuredClone(input.budget) } : {}),
				...(input.briefing !== undefined ? { briefing: structuredClone(input.briefing) } : {}),
				...(input.workerContext !== undefined ? { workerContext: structuredClone(input.workerContext) } : {}),
				...(input.steering !== undefined ? { steering: structuredClone(input.steering) } : {}),
				targetId: input.targetId,
				wireModelId: input.wireModelId,
				runtimeId: input.runtimeId,
				runtimeKind: input.runtimeKind,
				...(input.timing !== undefined ? { timing: structuredClone(input.timing) } : {}),
				startedAt: new Date().toISOString(),
				endedAt: null,
				status: "queued",
				exitCode: null,
				pid: null,
				heartbeatAt: null,
				sessionId: input.sessionId,
				cwd: input.cwd,
				tokenCount: 0,
				reasoningTokenCount: 0,
				...(input.staticShellHash !== undefined ? { staticShellHash: input.staticShellHash } : {}),
				...(input.sessionShellHash !== undefined ? { sessionShellHash: input.sessionShellHash } : {}),
				...(input.dynamicHash !== undefined ? { dynamicHash: input.dynamicHash } : {}),
				...(input.promptSignature !== undefined ? { promptSignature: input.promptSignature } : {}),
				...(input.toolSignature !== undefined ? { toolSignature: input.toolSignature } : {}),
				costUsd: 0,
			};
			runs.unshift(envelope);
			dirty.add(envelope.id);
			return cloneEnvelope(envelope);
		},

		update(id: string, patch: Partial<RunEnvelope>): RunEnvelope | null {
			const idx = findIndex(id);
			if (idx === -1) return null;
			const current = runs[idx];
			if (!current) return null;
			const next = applyPatch(current, patch);
			runs[idx] = next;
			dirty.add(id);
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

		async persist(): Promise<void> {
			// Checked twice: before the lock because acquiring it mkdirs the state
			// root back, and again under it because the removal can land while this
			// call waits for a sibling process to finish its own critical section.
			if (stateRootRemoved()) return;
			const target = runsPath();
			await withRunsLock(target, async () => {
				if (stateRootRemoved()) return;
				const diskRuns = readRuns();
				const merged = mergeRunsById(diskRuns, runs, dirty);
				const capped = capRuns(merged, resolveMaxRuns(opts?.maxRuns));
				runs = capped;
				const written = new Map(capped.map((run) => [run.id, run]));
				const contents = JSON.stringify(capped, null, 2);
				for (let attempt = 0; ; attempt += 1) {
					if (stateRootRemoved()) return;
					let skipped = false;
					try {
						await safeResourceWriteAsync(target, contents, {
							// The awaited fsync is a window an uninstall can land in (#428).
							withRename: (commit) => {
								if (stateRootRemoved()) skipped = true;
								else commit();
							},
						});
						break;
					} catch (error) {
						if (skipped) return;
						const code = (error as NodeJS.ErrnoException).code;
						if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
							throw error;
						}
						// Let pending close callbacks release Windows rename-blocking handles.
						await sleep(50);
					}
				}
				// A run that left the ring has no ledger row to view any more, so its
				// event journal is unreachable state. Retention is bound to the ring
				// rather than to a second policy so the two can never disagree about
				// how much history exists.
				if (merged.length > capped.length) {
					const kept = new Set(capped.map((run) => run.id));
					const evicted = merged.filter((run) => !kept.has(run.id)).map((run) => run.id);
					if (!stateRootRemoved()) {
						removeRunTelemetry(clioStateDir(), evicted);
						removeRunFeeds(clioStateDir(), evicted);
					}
				}
				// Keep updates made while a Windows rename retry yielded; clear only
				// the rows written so an old snapshot cannot overwrite a sibling later.
				const current = new Map(runs.map((run) => [run.id, run]));
				for (const id of dirty) {
					if (current.get(id) === written.get(id)) dirty.delete(id);
				}
			});
		},

		reload(): void {
			runs = readRuns();
			// The mirror was just replaced wholesale, so any unpersisted claim is gone.
			dirty.clear();
		},
	};
}
