/**
 * Dispatch run ledger with atomic writes (Phase 6 slice 2).
 *
 * On-disk layout under `clioStateDir()`:
 *   runs.json                    JSON array of RunEnvelope, newest first
 *   receipts/<runId>.json        per-run RunReceipt
 *
 * The ledger holds an in-memory mirror of runs.json. `create()` and `update()`
 * mutate memory only; `persist()` writes the bounded ring (default 1000, env
 * override `CLIO_CODER_MAX_DISPATCH_RUNS`) atomically via engine.atomicWrite.
 *
 * No worker spawning, no domain wire-up, no SafeEventBus emission yet. Those
 * land in P6S3 and P6S5. This slice is a pure persistence primitive.
 *
 * A crash between recordReceipt and persist leaves the receipt JSON on disk
 * without a ledger entry. The dispatch extension closes that gap at startup by
 * scanning receipts/ and adopting verified orphans back into the ledger via
 * adopt() (see orphan-recovery.ts).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGuardrail } from "../../core/guardrails.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { computeReceiptFindingsSummary } from "./receipt-findings.js";
import { withReceiptIntegrity } from "./receipt-integrity.js";
import type { RunEnvelope, RunReceipt, RunReceiptDraft, RunStatus } from "./types.js";

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
	recordReceipt(id: string, receipt: RunReceiptDraft): RunReceipt;
	/** Insert a fully-formed envelope recovered from a durable artifact. Returns false when the id already exists. */
	adopt(envelope: RunEnvelope): boolean;
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
	return join(clioStateDir(), "runs.json");
}

function receiptPathFor(runId: string): string {
	return join(clioStateDir(), "receipts", `${runId}.json`);
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

function resolveMaxRuns(opt?: number | undefined): number {
	if (opt !== undefined && opt > 0) return Math.floor(opt);
	// env (CLIO_CODER_MAX_DISPATCH_RUNS) > settings guardrails > default; see core/guardrails.ts.
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
				executionRole: input.executionRole,
				...(input.agentAudience !== undefined ? { agentAudience: input.agentAudience } : {}),
				...(input.requestOrigin !== undefined ? { requestOrigin: input.requestOrigin } : {}),
				task: input.task,
				...(input.briefing !== undefined ? { briefing: structuredClone(input.briefing) } : {}),
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
				receiptPath: null,
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

		recordReceipt(id: string, receipt: RunReceiptDraft): RunReceipt {
			const target = receiptPathFor(id);
			const idx = findIndex(id);
			if (idx === -1) {
				throw new Error(`dispatch ledger missing run for receipt '${id}'`);
			}
			const current = runs[idx];
			if (!current) {
				throw new Error(`dispatch ledger missing run for receipt '${id}'`);
			}
			// Fold the durable findings summary onto the draft before sealing so both
			// the ACP and worker finalizers get it for free and receipt integrity
			// digest covers it. Computed cheaply from in-memory fields; never reads
			// disk or calls buildEvidence.
			const draft: RunReceiptDraft =
				receipt.findingsSummary === undefined
					? { ...receipt, findingsSummary: computeReceiptFindingsSummary(receipt, current) }
					: receipt;
			const receiptWithIntegrity = withReceiptIntegrity(draft, current);
			// The sealed receipt is still returned to the finalizer that asked for
			// it; what it must not do is write the state root back into existence
			// under an uninstall. receiptPath stays null because no file was made.
			if (stateRootRemoved()) return receiptWithIntegrity;
			atomicWrite(target, JSON.stringify(receiptWithIntegrity, null, 2));
			runs[idx] = { ...current, receiptPath: target };
			return receiptWithIntegrity;
		},

		adopt(envelope: RunEnvelope): boolean {
			if (findIndex(envelope.id) !== -1) return false;
			runs.push(cloneEnvelope(envelope));
			runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
			return true;
		},

		async persist(): Promise<void> {
			// Checked twice: before the lock because acquiring it mkdirs the state
			// root back, and again under it because the removal can land while this
			// call waits for a sibling process to finish its own critical section.
			if (stateRootRemoved()) return;
			const target = runsPath();
			await withStateFileLock(target, () => {
				if (stateRootRemoved()) return;
				const diskRuns = readRuns();
				const merged = mergeRunsById(diskRuns, runs);
				const capped = capRuns(merged, maxRuns);
				runs = capped;
				atomicWrite(target, JSON.stringify(capped, null, 2));
			});
		},

		reload(): void {
			runs = readRuns();
		},
	};
}
