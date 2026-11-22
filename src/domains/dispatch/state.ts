/**
 * Dispatch run ledger with atomic writes.
 *
 * On-disk layout under `clioStateDir()`:
 *   runs.json                    JSON array of RunEnvelope, newest first
 *
 * The ledger holds an in-memory mirror of runs.json. `create()` and `update()`
 * mutate memory only; `persist()` writes the settings-bounded ring (default
 * 1000) atomically via safeResourceWriteAsync. Dispatch persists on lifecycle
 * and heartbeat transitions only, never for a live worker's spend: that lives
 * in the run's journal, which every reader in another process folds (FL-24).
 *
 * This module owns persistence. The dispatch extension wires worker spawning,
 * cross-domain coordination, and event emission around this ledger. A finished
 * run's record is its run journal's run.settled, not a row here; a row whose
 * host died before its terminal patch persisted is settled from that record at
 * startup (orphan-recovery.ts).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { resolveGuardrail } from "../../core/guardrails.js";
import { safeResourceWrite, safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { spendSumsOf, unobservedRunUsageFacts } from "../../core/telemetry/pricing.js";
import { RunSpendSumsSchema, RunUsageFactsSchema } from "../../core/telemetry/schemas.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { type AgentRoleFactsResolver, recordedRoleIsCurrent } from "./execution-role.js";
import type { ExecutionStepResult } from "./execution-scheduler.js";
import { removeRunFeeds } from "./run-feed.js";
import type { RunEnvelope, RunStatus } from "./types.js";

/** One fleet root's durable record. */
export interface FleetRunRecord {
	version: 1;
	id: string;
	/** Workspace that launched this root. */
	cwd: string;
	fleet: string;
	planHash: string;
	/** The plan hash before endpoint binding. */
	planIdentityHash: string;
	stepIds: string[];
	planSteps: unknown[];
	vars: Record<string, string>;
	startedAt: string;
	endedAt: string | null;
	resumedFrom: string | null;
	/** Run id of the kept task worktree an isolated (`worktree`-scoped) run executes in; a resume continues there. */
	worktree?: string;
	steps: Array<{ stepId: string; result: ExecutionStepResult }>;
}

export interface LedgerOptions {
	maxRuns?: number;
	/** Recipe facts for the role rule; without them only the vocabulary and gate positions judge a row's role. */
	roleFacts?: AgentRoleFactsResolver;
}

export type CreateRunInput = Omit<
	RunEnvelope,
	"version" | "id" | "startedAt" | "endedAt" | "exitCode" | "status" | "pid" | "heartbeatAt" | "spend" | "spendSums"
> & { id?: string };

export interface Ledger {
	create(input: CreateRunInput): RunEnvelope;
	update(id: string, patch: Partial<RunEnvelope>): RunEnvelope | null;
	get(id: string): RunEnvelope | null;
	/** The row itself, uncloned, for a hot read that neither keeps nor mutates it. */
	peek(id: string): Readonly<RunEnvelope> | null;
	/** `where` selects rows before they are copied, so a caller after a few rows does not clone the whole ring. */
	list(opts?: {
		status?: RunStatus;
		limit?: number;
		where?: (run: Readonly<RunEnvelope>) => boolean;
	}): ReadonlyArray<RunEnvelope>;
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
		return parsed.version === 1 &&
			parsed.id === runId &&
			typeof parsed.cwd === "string" &&
			typeof parsed.planIdentityHash === "string" &&
			Array.isArray(parsed.planSteps)
			? structuredClone(parsed)
			: null;
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
	const dir = join(clioStateDir(), "fleet-runs");
	const modifiedAt = (name: string): number => {
		try {
			return statSync(join(dir, name)).mtimeMs;
		} catch {
			return 0;
		}
	};
	// Ids are random, so the cap keeps the newest rather than whichever sort first.
	const names = entries
		.filter((name) => name.endsWith(".json"))
		.map((name) => ({ name, at: modifiedAt(name) }))
		.sort((a, b) => b.at - a.at)
		.slice(0, MAX_FLEET_RUN_SCAN)
		.map((entry) => entry.name);
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
/**
 * Checks for a row's spend shapes. `Value.Check` walks the schema at about 1 ms a row, and every process reads the
 * ledger several times (dispatch start, each settlement, every persist), so a ledger near its 1000-row default cap cost
 * seconds a launch. A compiled checker accepts and rejects exactly what `Value.Check` does at a few microseconds a row,
 * after a one-time compile of about 17 ms, so it is built only once a ledger is long enough to repay it.
 */
type RowCheck = (value: unknown) => boolean;
const COMPILE_ROW_CHECKS_AT = 16;
let compiledRowChecks: { spend: RowCheck; sums: RowCheck } | null = null;
function rowChecks(rows: number): { spend: RowCheck; sums: RowCheck } {
	if (compiledRowChecks) return compiledRowChecks;
	if (rows < COMPILE_ROW_CHECKS_AT)
		return {
			spend: (value) => Value.Check(RunUsageFactsSchema, value),
			sums: (value) => Value.Check(RunSpendSumsSchema, value),
		};
	const spend = Compile(RunUsageFactsSchema);
	const sums = Compile(RunSpendSumsSchema);
	compiledRowChecks = { spend: (value) => spend.Check(value), sums: (value) => sums.Check(value) };
	return compiledRowChecks;
}

function readRuns(path = runsPath(), roleFacts?: AgentRoleFactsResolver): RunEnvelope[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8").trim();
	if (raw.length === 0) return [];
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) return [];
	// The ledger is live fleet state, not history: a file in any other shape is replaced on the next write, never
	// read, so a row whose spend is not one fact and one sum per quantity drops the whole file (#434).
	const envelopes: RunEnvelope[] = [];
	const check = rowChecks(parsed.length);
	for (const entry of parsed) {
		if (!isRecord(entry) || entry.version !== 1 || !check.spend(entry.spend) || !check.sums(entry.spendSums)) return [];
		const run = entry as unknown as RunEnvelope;
		// A row whose role the rule no longer assigns is dropped, never relabeled; adaptive routing relearns that
		// population (row 352). A live row is its writer's own state, so only a finished row answers to the recipe.
		if (!recordedRoleIsCurrent(run, run.endedAt === null ? undefined : roleFacts)) continue;
		envelopes.push(run);
	}
	return envelopes;
}

/** A poller's copy of the ledger rows and the runs.json stamp they were read at. */
export interface LedgerSnapshot {
	stamp: string | null;
	runs: ReadonlyArray<RunEnvelope>;
}

/**
 * The ledger rows, parsed again only when runs.json changed since `previous` was read. A poller that re-parsed the
 * whole file every tick paid about 156 ms of CPU a poll at the 1000-row cap whether or not anything was written
 * (FL-24). A torn or failed read keeps the previous rows, and the stamp it keeps makes the next poll try again.
 */
export function readLedgerSnapshot(previous: LedgerSnapshot | null, stateDir: string = clioStateDir()): LedgerSnapshot {
	const path = join(stateDir, "runs.json");
	const stamp = fileStamp(path);
	if (stamp === null) return { stamp: null, runs: [] };
	if (previous !== null && previous.stamp === stamp) return previous;
	try {
		return { stamp, runs: Object.freeze(readRuns(path)) };
	} catch {
		// The writer replaces the file atomically; a failed parse is a race the next poll wins.
		return previous ?? { stamp: null, runs: [] };
	}
}

/**
 * When each ledger run ended, in epoch ms, or null while it has not; a run the map does not name is unknown to the
 * ledger. A row without an end may still be recovered, so state kept for a run is kept while its end is null.
 * A ledger file that does not parse throws, so a caller never mistakes it for an empty ledger.
 */
export function readRunEnds(stateDir = clioStateDir()): ReadonlyMap<string, number | null> {
	const ends = new Map<string, number | null>();
	for (const run of readRuns(join(stateDir, "runs.json"))) {
		const end = run.endedAt === null ? Number.NaN : Date.parse(run.endedAt);
		ends.set(run.id, Number.isFinite(end) ? end : null);
	}
	return ends;
}

/**
 * When the runs that used each worker context seed ended, keyed by the seed's content hash: the latest end, or null
 * while any of them has not ended. A seed no ledger run names is unknown. Throws like readRunEnds (FL-8).
 */
export function readContextSeedEnds(stateDir = clioStateDir()): ReadonlyMap<string, number | null> {
	const ends = new Map<string, number | null>();
	for (const run of readRuns(join(stateDir, "runs.json"))) {
		const hash = run.workerContext?.contentHash;
		if (typeof hash !== "string" || ends.get(hash) === null) continue;
		const end = run.endedAt === null ? Number.NaN : Date.parse(run.endedAt);
		const prior = ends.get(hash);
		ends.set(hash, Number.isFinite(end) ? Math.max(end, prior ?? end) : null);
	}
	return ends;
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

/** A file's identity and content stamp; a rename over it changes the inode, an append its size and mtime. */
function fileStamp(path: string): string | null {
	try {
		const stat = statSync(path);
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch {
		return null;
	}
}

export function openLedger(opts?: LedgerOptions): Ledger {
	let runs: RunEnvelope[] = readRuns(runsPath(), opts?.roleFacts);
	// Ids this process has written since the last successful persist. See
	// mergeRunsById: this is what separates our writes from a sibling's rows we
	// merely read at open time.
	const dirty = new Set<string>();
	/**
	 * The rows this ledger last wrote and the file's stamp right after, taken under the lock. While the file still
	 * carries that stamp no other writer replaced it, so the next persist merges onto these rows instead of reading
	 * and parsing the whole file back.
	 */
	let lastWrite: { path: string; stamp: string; rows: RunEnvelope[] } | null = null;

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
				...(input.rootRequestOrigin !== undefined ? { rootRequestOrigin: input.rootRequestOrigin } : {}),
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
				spend: unobservedRunUsageFacts(),
				spendSums: spendSumsOf(unobservedRunUsageFacts()),
				...(input.staticShellHash !== undefined ? { staticShellHash: input.staticShellHash } : {}),
				...(input.sessionShellHash !== undefined ? { sessionShellHash: input.sessionShellHash } : {}),
				...(input.dynamicHash !== undefined ? { dynamicHash: input.dynamicHash } : {}),
				...(input.promptSignature !== undefined ? { promptSignature: input.promptSignature } : {}),
				...(input.toolSignature !== undefined ? { toolSignature: input.toolSignature } : {}),
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

		peek(id: string): Readonly<RunEnvelope> | null {
			return runs.find((r) => r.id === id) ?? null;
		},

		list(opts?: {
			status?: RunStatus;
			limit?: number;
			where?: (run: Readonly<RunEnvelope>) => boolean;
		}): ReadonlyArray<RunEnvelope> {
			let filtered: RunEnvelope[] = runs;
			if (opts?.status) {
				const want = opts.status;
				filtered = filtered.filter((r) => r.status === want);
			}
			if (opts?.where) filtered = filtered.filter(opts.where);
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
			// Dispatch drains persist on every shutdown, twice for a headless run. A clean ledger whose disk rows are
			// already in ring order and within the cap would rewrite runs.json byte for byte under the lock with two
			// fsyncs, so it adopts those rows instead. A lowered cap still evicts through the write below.
			if (dirty.size === 0) {
				const disk = readRuns(runsPath(), opts?.roleFacts);
				const capped = capRuns(mergeRunsById(disk, runs, dirty), resolveMaxRuns(opts?.maxRuns));
				if (capped.length === disk.length && capped.every((run, index) => run === disk[index])) {
					runs = capped;
					return;
				}
			}
			const target = runsPath();
			await withRunsLock(target, async () => {
				if (stateRootRemoved()) return;
				const unchanged = lastWrite !== null && lastWrite.path === target && lastWrite.stamp === fileStamp(target);
				const diskRuns = unchanged && lastWrite !== null ? lastWrite.rows : readRuns(runsPath(), opts?.roleFacts);
				const merged = mergeRunsById(diskRuns, runs, dirty);
				const capped = capRuns(merged, resolveMaxRuns(opts?.maxRuns));
				runs = capped;
				const written = new Map(capped.map((run) => [run.id, run]));
				const writtenRows = [...capped];
				const contents = JSON.stringify(capped, null, 2);
				lastWrite = null;
				for (let attempt = 0; ; attempt += 1) {
					if (stateRootRemoved()) return;
					let skipped = false;
					try {
						await safeResourceWriteAsync(target, contents, {
							mode: 0o600,
							// The awaited fsync is a window an uninstall can land in (#428).
							withRename: (commit) => {
								if (stateRootRemoved()) skipped = true;
								else commit();
							},
						});
						const stamp = fileStamp(target);
						if (stamp !== null) lastWrite = { path: target, stamp, rows: writtenRows };
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
				// Bound display feeds with the ledger. Telemetry journals may still be referenced by retained sessions
				// and belong to the separate reference-aware telemetry prune policy.
				if (merged.length > capped.length) {
					const kept = new Set(capped.map((run) => run.id));
					const evicted = merged.filter((run) => !kept.has(run.id)).map((run) => run.id);
					if (!stateRootRemoved()) {
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
			runs = readRuns(runsPath(), opts?.roleFacts);
			// The mirror was just replaced wholesale, so any unpersisted claim is gone.
			dirty.clear();
		},
	};
}
