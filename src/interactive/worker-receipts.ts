/**
 * Sealed-receipt reader for worker transcript blocks.
 *
 * The receipt under `<state>/receipts/<runId>.json` is the terminal truth for a
 * dispatched run: the domain writes it before it publishes the run's terminal
 * event, so by the time a transcript wants a footer the file is there. This is
 * the one place that turns it into the compact facts the worker entry renders,
 * shared by the live subscription and by session replay, so both draw the same
 * numbers from the same bytes.
 *
 * Every failure path returns null rather than throwing. A missing or corrupt
 * receipt is an operator-visible state (`receipt unavailable`), never a reason
 * to take down a render.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../core/xdg.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { inspectRunReceiptTrustStatus } from "../domains/evidence/trust-status.js";
import { receiptFilePath } from "./view/artifacts.js";
import type { WorkerPresentedResultContract, WorkerReceiptFacts, WorkerResultContract } from "./worker-stream.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function elapsedMsFrom(receipt: Record<string, unknown>): number | undefined {
	const startedAt = Date.parse(String(receipt.startedAt ?? ""));
	const endedAt = Date.parse(String(receipt.endedAt ?? ""));
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
	return Math.max(0, endedAt - startedAt);
}

/**
 * Result-contract conformance, plus the "unmeasured" case the receipt spells as
 * a null contract fact: a run that never had a typed contract to conform to.
 */
function contractFrom(receipt: Record<string, unknown>): WorkerResultContract | undefined {
	const quality = isRecord(receipt.quality) ? receipt.quality : null;
	if (quality === null) return undefined;
	if (!Object.hasOwn(quality, "resultContract")) return undefined;
	const fact = quality.resultContract;
	if (fact === null) return "unmeasured";
	if (!isRecord(fact)) return undefined;
	const conformance = fact.conformance;
	return conformance === "pass" || conformance === "fail" || conformance === "not-reached" ? conformance : undefined;
}

const PRESENTED_RESULT_CONTRACTS: ReadonlyArray<WorkerPresentedResultContract> = [
	"debugger-report",
	"verifier-report",
	"research-report",
	"scout-report",
];

/** The kind is integrity-covered inside the validator source id on current receipts. */
function contractKindFrom(receipt: Record<string, unknown>): WorkerPresentedResultContract | undefined {
	const quality = isRecord(receipt.quality) ? receipt.quality : null;
	const fact = quality !== null && isRecord(quality.resultContract) ? quality.resultContract : null;
	const sourceId = optionalString(fact?.sourceId);
	if (sourceId === undefined) return undefined;
	return PRESENTED_RESULT_CONTRACTS.find((kind) => sourceId.startsWith(`agent-result-contract:${kind}:`));
}

/**
 * Project a parsed receipt onto the facts a worker block renders. The input is
 * whatever JSON the file held, not a typed {@link RunReceipt}: receipts written
 * by older versions of Clio are still valid history, so every field is read
 * structurally and a missing one degrades the footer rather than the render.
 */
export function workerReceiptFacts(receipt: Record<string, unknown>): WorkerReceiptFacts | null {
	const outcome = optionalString(receipt.outcome);
	if (outcome === undefined) return null;
	const output = isRecord(receipt.output) ? receipt.output : null;
	const contract = contractFrom(receipt);
	const contractKind = contractKindFrom(receipt);
	const text = optionalString(output?.text);
	const failureMessage = optionalString(receipt.failureMessage);
	const outcomeCode = optionalString(receipt.outcomeCode);
	const exitCode = optionalNumber(receipt.exitCode);
	const tokenCount = optionalNumber(receipt.tokenCount);
	const durationMs = elapsedMsFrom(receipt);
	const toolCalls = optionalNumber(receipt.toolCalls);
	return {
		outcome,
		...(outcomeCode !== undefined ? { outcomeCode } : {}),
		...(failureMessage !== undefined ? { failureMessage } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
		...(tokenCount !== undefined ? { tokenCount } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(toolCalls !== undefined ? { toolCalls } : {}),
		...(contract !== undefined ? { contract } : {}),
		...(contractKind !== undefined ? { contractKind } : {}),
		...(text !== undefined ? { text } : {}),
	};
}

/** Read and project `<state>/receipts/<runId>.json` alone; null when it is absent or unreadable. */
function readReceiptFileFacts(runId: string, stateDir: string): WorkerReceiptFacts | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(receiptFilePath(stateDir, runId), "utf8"));
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const facts = workerReceiptFacts(parsed);
	if (facts === null) return null;
	// The trust verdict is an authenticated read-back: the receipt file
	// against the ledger row it was sealed from. Without the row there is no
	// authentication, and no verdict is better than a guessed one.
	const row = findRunRow(runId, stateDir);
	if (row === null) return facts;
	const trust = inspectRunReceiptTrustStatus(parsed as unknown as RunReceipt, row as unknown as RunEnvelope).status;
	return { ...facts, trust };
}

/** Read and project `<state>/receipts/<runId>.json`; null when it is absent or unreadable. */
export function readWorkerReceiptFacts(runId: string, stateDir = clioStateDir()): WorkerReceiptFacts | null {
	return readReceiptFileFacts(runId, stateDir);
}

/**
 * The subset of a `runs.json` row replay needs once a receipt has failed to
 * read: whether the run is still open, and, if the ledger closed it early
 * (`closeAbandonedRows`), the closing row's own explanation.
 */
function findRunRow(runId: string, stateDir: string): Record<string, unknown> | null {
	const path = join(stateDir, "runs.json");
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return null;
		for (const entry of parsed) {
			if (isRecord(entry) && entry.id === runId) return entry;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Replay-only receipt reader: falls back to the run's own `runs.json` row
 * when no receipt was sealed for it, so a resumed transcript can tell a run
 * still going in another process, one the ledger closed as dead/stalled
 * before it could seal a receipt, and one whose evidence is genuinely gone
 * apart from each other. Never used by the live subscription: there, a
 * missing receipt at settle time is a flush race the terminal event's own
 * payload already covers (`worker-stream.ts`'s `settle`), not an open run.
 */
export function readWorkerReceiptFactsForReplay(runId: string, stateDir = clioStateDir()): WorkerReceiptFacts | null {
	const sealed = readReceiptFileFacts(runId, stateDir);
	if (sealed !== null) return sealed;
	const row = findRunRow(runId, stateDir);
	if (row === null) return null;
	if (row.endedAt === null || row.endedAt === undefined) return { outcome: "running", stillRunning: true };
	const outcome = optionalString(row.outcome) ?? optionalString(row.status) ?? "unknown";
	const abandonedDetail = optionalString(row.outcomeDetail);
	return {
		outcome,
		...(abandonedDetail !== undefined ? { abandonedDetail } : {}),
	};
}
