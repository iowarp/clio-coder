/**
 * Startup recovery of orphaned receipts (Symphony P10: restart resumes from
 * durable artifacts, not in-memory state).
 *
 * A crash between recordReceipt() and persist() leaves a sealed receipt on
 * disk with no runs.json row. At dispatch-extension startup this module scans
 * the receipts directory, reconstructs the ledger row each orphan was sealed
 * against, verifies the integrity digest, and adopts valid orphans back into
 * the ledger. Receipts that fail verification are renamed with a `.corrupt`
 * suffix, never deleted. Receipts that cannot be reconstructed (pre-sprint
 * receipts without a reproducibility block) are left untouched and counted as
 * skipped: quarantining an unverifiable-but-possibly-valid artifact would
 * destroy evidence.
 */

import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir } from "../../core/xdg.js";
import { runStatusForOutcome } from "./outcome.js";
import { isReceiptIntegrity, verifyReceiptIntegrity } from "./receipt-integrity.js";
import type { Ledger } from "./state.js";
import type { RunEnvelope, RunReceipt, RunStatus } from "./types.js";

export interface OrphanRecoverySummary {
	recovered: number;
	corrupt: number;
	skipped: number;
	/** Non-terminal rows whose worker process no longer exists, closed as stalled. */
	abandoned: number;
}

/**
 * Statuses the pre-taxonomy finalizer could have written. Tried in likelihood
 * order; the integrity digest picks the right one.
 */
const STATUS_CANDIDATES: ReadonlyArray<RunStatus> = ["completed", "failed", "interrupted", "dead", "stale"];

function receiptsDir(): string {
	return join(clioDataDir(), "receipts");
}

/**
 * Rebuild the RunEnvelope the receipt was sealed against. Every field the
 * integrity digest covers is either present on the receipt verbatim or fixed
 * by construction at finalization time (status is the only free variable).
 */
function envelopeFromReceipt(receipt: RunReceipt, status: RunStatus, receiptPath: string): RunEnvelope {
	const envelope: RunEnvelope = {
		id: receipt.runId,
		agentId: receipt.agentId,
		...(receipt.agentAudience !== undefined ? { agentAudience: receipt.agentAudience } : {}),
		...(receipt.requestOrigin !== undefined ? { requestOrigin: receipt.requestOrigin } : {}),
		task: receipt.task,
		endpointId: receipt.endpointId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		runtimeKind: receipt.runtimeKind,
		startedAt: receipt.startedAt,
		endedAt: receipt.endedAt,
		status,
		exitCode: receipt.exitCode,
		pid: null,
		heartbeatAt: null,
		receiptPath,
		sessionId: receipt.sessionId,
		cwd: receipt.reproducibility?.cwd ?? "",
		tokenCount: receipt.tokenCount,
		costUsd: receipt.costUsd,
	};
	if (receipt.cacheReadTokenCount !== undefined) envelope.cacheReadTokenCount = receipt.cacheReadTokenCount;
	if (receipt.cacheWriteTokenCount !== undefined) envelope.cacheWriteTokenCount = receipt.cacheWriteTokenCount;
	if (receipt.reasoningTokenCount !== undefined) envelope.reasoningTokenCount = receipt.reasoningTokenCount;
	if (receipt.staticShellHash !== undefined) envelope.staticShellHash = receipt.staticShellHash;
	if (receipt.sessionShellHash !== undefined) envelope.sessionShellHash = receipt.sessionShellHash;
	if (receipt.dynamicHash !== undefined) envelope.dynamicHash = receipt.dynamicHash;
	if (receipt.promptSignature !== undefined) envelope.promptSignature = receipt.promptSignature;
	if (receipt.toolSignature !== undefined) envelope.toolSignature = receipt.toolSignature;
	if (receipt.outcome !== undefined) {
		envelope.outcome = receipt.outcome;
		envelope.outcomeDetail = receipt.outcomeDetail ?? null;
	}
	if (receipt.lineage !== undefined) envelope.lineage = receipt.lineage;
	if (receipt.identity !== undefined) envelope.identity = receipt.identity;
	return envelope;
}

function verifyOrphan(receipt: RunReceipt, receiptPath: string): RunEnvelope | null {
	const candidates: ReadonlyArray<RunStatus> =
		receipt.outcome !== undefined ? [runStatusForOutcome(receipt.outcome)] : STATUS_CANDIDATES;
	for (const status of candidates) {
		const envelope = envelopeFromReceipt(receipt, status, receiptPath);
		if (verifyReceiptIntegrity(receipt, envelope).ok) return envelope;
	}
	return null;
}

function quarantine(path: string): boolean {
	try {
		renameSync(path, `${path}.corrupt`);
		return true;
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number | null): boolean {
	if (pid === null || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

const NON_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "stale", "dead"]);

/**
 * Close abandoned ledger rows: a non-terminal row whose recorded worker pid
 * no longer exists belongs to an orchestrator that died mid-run. There is no
 * receipt to seal (the run never finalized), so the row is closed in place
 * with outcome "stalled" rather than left as a permanent ghost in status
 * output.
 */
function closeAbandonedRows(ledger: Ledger): number {
	let closed = 0;
	for (const row of ledger.list()) {
		if (row.endedAt !== null || !NON_TERMINAL_STATUSES.has(row.status)) continue;
		if (isProcessAlive(row.pid)) continue;
		ledger.update(row.id, {
			status: "dead",
			outcome: "stalled",
			outcomeDetail: "abandoned: orchestrator exited before the run finalized",
			endedAt: new Date().toISOString(),
			exitCode: row.exitCode ?? 1,
		});
		closed += 1;
	}
	return closed;
}

export function recoverOrphanReceipts(ledger: Ledger): OrphanRecoverySummary {
	const summary: OrphanRecoverySummary = { recovered: 0, corrupt: 0, skipped: 0, abandoned: 0 };
	summary.abandoned = closeAbandonedRows(ledger);
	const dir = receiptsDir();
	if (!existsSync(dir)) return summary;
	// Retention horizon: the ledger is a bounded ring, so a receipt older than
	// the oldest retained row was evicted by the cap, not orphaned by a crash
	// (a crash orphan was running when the process died, making it newer than
	// the oldest of the retained rows). Re-adopting evicted receipts would
	// churn against the ring on every startup. An empty ledger disables the
	// horizon so a wiped runs.json can be rebuilt from receipts.
	const rows = ledger.list();
	const oldestRetained = rows.length > 0 ? (rows[rows.length - 1]?.startedAt ?? null) : null;
	let files: string[];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return summary;
	}
	for (const name of files) {
		const path = join(dir, name);
		let receipt: RunReceipt;
		try {
			receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
		} catch {
			summary.corrupt += quarantine(path) ? 1 : 0;
			continue;
		}
		if (typeof receipt?.runId !== "string" || receipt.runId.length === 0) {
			summary.corrupt += quarantine(path) ? 1 : 0;
			continue;
		}
		if (ledger.get(receipt.runId) !== null) continue;
		if (oldestRetained !== null && typeof receipt.startedAt === "string" && receipt.startedAt < oldestRetained) {
			continue;
		}
		if (!isReceiptIntegrity(receipt.integrity)) {
			summary.corrupt += quarantine(path) ? 1 : 0;
			continue;
		}
		if (receipt.reproducibility?.cwd === undefined) {
			// Cannot reconstruct the sealed ledger row without cwd; leave the
			// artifact in place rather than quarantine something unverifiable.
			summary.skipped += 1;
			continue;
		}
		const envelope = verifyOrphan(receipt, path);
		if (envelope === null) {
			summary.corrupt += quarantine(path) ? 1 : 0;
			continue;
		}
		if (ledger.adopt(envelope)) summary.recovered += 1;
	}
	return summary;
}
