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
import { hostname } from "node:os";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
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
	/** Non-terminal rows whose worker process is gone but whose own receipt verified, sealed from it. */
	sealed: number;
}

/**
 * Statuses the pre-taxonomy finalizer could have written. Tried in likelihood
 * order; the integrity digest picks the right one.
 */
const STATUS_CANDIDATES: ReadonlyArray<RunStatus> = ["completed", "failed", "interrupted", "dead", "stale"];

function receiptsDir(): string {
	return join(clioStateDir(), "receipts");
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
		executionRole: receipt.executionRole,
		...(receipt.agentAudience !== undefined ? { agentAudience: receipt.agentAudience } : {}),
		...(receipt.requestOrigin !== undefined ? { requestOrigin: receipt.requestOrigin } : {}),
		task: receipt.task,
		...(receipt.budget !== undefined ? { budget: receipt.budget } : {}),
		...(receipt.briefing !== undefined ? { briefing: receipt.briefing } : {}),
		...(receipt.steering !== undefined ? { steering: receipt.steering } : {}),
		targetId: receipt.targetId,
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
	if (receipt.inputTokenCount !== undefined) envelope.inputTokenCount = receipt.inputTokenCount;
	if (receipt.outputTokenCount !== undefined) envelope.outputTokenCount = receipt.outputTokenCount;
	if (receipt.staticShellHash !== undefined) envelope.staticShellHash = receipt.staticShellHash;
	if (receipt.sessionShellHash !== undefined) envelope.sessionShellHash = receipt.sessionShellHash;
	if (receipt.dynamicHash !== undefined) envelope.dynamicHash = receipt.dynamicHash;
	if (receipt.promptSignature !== undefined) envelope.promptSignature = receipt.promptSignature;
	if (receipt.toolSignature !== undefined) envelope.toolSignature = receipt.toolSignature;
	if (receipt.outcome !== undefined) {
		envelope.outcome = receipt.outcome;
		envelope.outcomeDetail = receipt.outcomeDetail ?? null;
	}
	if (receipt.outcomeCode !== undefined) envelope.outcomeCode = receipt.outcomeCode;
	if (receipt.lineage !== undefined) envelope.lineage = receipt.lineage;
	if (receipt.identity !== undefined) envelope.identity = receipt.identity;
	if (receipt.node !== undefined) envelope.node = receipt.node;
	if (receipt.reroutes !== undefined) envelope.reroutes = receipt.reroutes;
	if (receipt.pipeline !== undefined) envelope.pipeline = receipt.pipeline;
	if (receipt.gate !== undefined) envelope.gate = receipt.gate;
	if (receipt.plan !== undefined) envelope.plan = receipt.plan;
	if (receipt.personaOverride !== undefined) envelope.personaOverride = receipt.personaOverride;
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
 * The sealed receipt for a row that never made it to a persisted terminal
 * state, or null when there is no receipt or it does not verify against a
 * reconstructable envelope. A run writes its receipt before it persists the
 * ledger, so this window is exactly where a crash or a clobbered persist leaves
 * the truth on disk in the receipt and a lie in the row.
 */
function sealedEnvelopeFor(runId: string): RunEnvelope | null {
	const path = join(receiptsDir(), `${runId}.json`);
	if (!existsSync(path)) return null;
	let receipt: RunReceipt;
	try {
		receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
	} catch {
		return null;
	}
	if (receipt?.runId !== runId) return null;
	if (!isReceiptIntegrity(receipt.integrity)) return null;
	if (receipt.reproducibility?.cwd === undefined) return null;
	return verifyOrphan(receipt, path);
}

/**
 * Close abandoned ledger rows: a non-terminal row whose recorded worker pid
 * no longer exists belongs to an orchestrator that died mid-run.
 *
 * Such a row may still have a sealed receipt on disk. A run writes its receipt
 * before it persists the settled row, so a crash or a clobbered persist in that
 * window leaves a receipt saying `succeeded`/0 next to a row that still says
 * `running`. Stamping the row dead without looking was how a finished dispatch
 * came to be recorded as a failure, and the receipt pass below could not repair
 * it afterwards because it only adopts receipts with no row at all. So the
 * receipt decides when it verifies, and only a row with nothing to seal is
 * closed as "stalled" rather than left as a permanent ghost in status output.
 *
 * `endedAt` is the last instant the run was observed alive, not the instant
 * recovery noticed it was gone. Stamping recovery time made every phase
 * duration derived from the row (`executionMs`, `totalEndToEndMs`) span the
 * whole orchestrator downtime, which is not a measurement of anything. The
 * last heartbeat is the honest bound; a row that never heartbeat has only its
 * own start, which reads as a zero-length run rather than an invented one.
 *
 * A restart has no shared monotonic origin with the process that owned the
 * worker, so recovery never estimates heartbeat age. It first adjudicates the
 * host-scoped pid and uses the persisted wall-clock heartbeat only as this
 * display/evidence bound after that process is known to be gone.
 */
function closeAbandonedRows(ledger: Ledger): { closed: number; sealed: number } {
	let closed = 0;
	let sealed = 0;
	const localHost = hostname();
	for (const row of ledger.list()) {
		if (row.endedAt !== null || !NON_TERMINAL_STATUSES.has(row.status)) continue;
		// Transport-scoped liveness: the recorded pid is always a process on
		// the orchestrator host that created the row (for ssh runs it is the
		// local ssh client, i.e. the channel itself). On a shared filesystem
		// the ledger is visible from other hosts, where a local pid probe would
		// adjudicate the wrong process; rows created by another host are left
		// for that host's own recovery pass.
		if (row.identity !== undefined && row.identity.host !== localHost) continue;
		if (isProcessAlive(row.pid)) continue;
		const envelope = sealedEnvelopeFor(row.id);
		if (envelope !== null) {
			// Patch rather than replace: the row carries phase timings and lineage
			// the receipt does not, and pid/heartbeatAt are this row's own history.
			const { id: _id, pid: _pid, heartbeatAt: _heartbeatAt, ...settled } = envelope;
			ledger.update(row.id, settled);
			sealed += 1;
			continue;
		}
		ledger.update(row.id, {
			status: "dead",
			outcome: "stalled",
			outcomeDetail: "abandoned: orchestrator exited before the run finalized",
			endedAt: row.heartbeatAt ?? row.startedAt,
			exitCode: row.exitCode ?? 1,
		});
		closed += 1;
	}
	return { closed, sealed };
}

export function recoverOrphanReceipts(ledger: Ledger): OrphanRecoverySummary {
	const summary: OrphanRecoverySummary = { recovered: 0, corrupt: 0, skipped: 0, abandoned: 0, sealed: 0 };
	const abandoned = closeAbandonedRows(ledger);
	summary.abandoned = abandoned.closed;
	summary.sealed = abandoned.sealed;
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
