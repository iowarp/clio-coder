/**
 * Invariant metrics: the promises Clio makes about its own machinery, read
 * from the journal one eval item left behind.
 *
 * These invert what a benchmark measures. A weak model that never solved the
 * task leaves every one of them intact; a strong model that solved it leaves
 * them broken the moment Clio failed to seal, to agree with itself, or to
 * write a receipt its own ledger can authenticate. The task outcome and the
 * machinery's behavior are separate readings, and only the second is a gate.
 *
 * Every reader here is total and never throws. A metric this pass could not
 * compute is absent rather than false: a threshold on an absent metric fails
 * closed, while a fabricated value would be indistinguishable from a check
 * that ran and passed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReceiptIntegrity } from "../../dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../../dispatch/types.js";

export interface EvalRunJournal {
	/** Ledger envelopes by run id. The authority a receipt is authenticated against. */
	envelopes: Map<string, RunEnvelope>;
	/** Receipts that parsed into receipt shape. */
	receipts: RunReceipt[];
	/**
	 * Files present under receipts/. A file Clio wrote that no longer parses
	 * as a receipt is a sealed artifact that cannot be read, so the count is
	 * kept apart from `receipts.length` rather than folded into it.
	 */
	receiptFiles: number;
}

/**
 * Read the run ledger and receipts an eval item's Clio wrote under its own
 * state directory. Returns null when there is no such directory to read, which
 * is the one case where the invariants below are genuinely unobservable.
 */
export function readRunJournal(stateDir: string): EvalRunJournal | null {
	if (!existsSync(stateDir)) return null;
	return {
		envelopes: readEnvelopes(join(stateDir, "runs.json")),
		...readReceipts(join(stateDir, "receipts")),
	};
}

function readEnvelopes(runsPath: string): Map<string, RunEnvelope> {
	const envelopes = new Map<string, RunEnvelope>();
	if (!existsSync(runsPath)) return envelopes;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(runsPath, "utf8")) as unknown;
	} catch {
		return envelopes;
	}
	if (!Array.isArray(parsed)) return envelopes;
	for (const entry of parsed) {
		if (isRecord(entry) && typeof entry.id === "string") envelopes.set(entry.id, entry as unknown as RunEnvelope);
	}
	return envelopes;
}

function readReceipts(receiptsDir: string): { receipts: RunReceipt[]; receiptFiles: number } {
	if (!existsSync(receiptsDir)) return { receipts: [], receiptFiles: 0 };
	let names: string[];
	try {
		names = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
	} catch {
		return { receipts: [], receiptFiles: 0 };
	}
	const receipts: RunReceipt[] = [];
	for (const name of names) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(receiptsDir, name), "utf8"));
			if (isReceiptShaped(parsed)) receipts.push(parsed);
		} catch {
			// Counted by receiptFiles below: an unreadable receipt is a broken
			// seal, not a receipt that was never written.
		}
	}
	return { receipts, receiptFiles: names.length };
}

/**
 * Invariant metrics for one eval item.
 *
 * - `receipt.count` / `receipt.sealed`: how many receipts this item's Clio
 *   sealed. Zero is an observation, not an absence: the journal was readable
 *   and empty.
 * - `receipt.rootCount`: receipts that begin their own lineage. One per
 *   operator-initiated run; a plan with retries has more.
 * - `receipt.integrityValid`: every sealed receipt parsed and authenticated
 *   against its own ledger envelope through `verifyReceiptIntegrity`. Absent
 *   when nothing sealed, because there is no seal to judge.
 * - `receipt.outcomeMatchesExit`: no receipt claims an outcome its own exit
 *   code contradicts, and where exactly one root receipt exists, its success
 *   agrees with the exit status the process reported. A receipt that says
 *   `succeeded` while the process exited nonzero is the failure this catches.
 *   With several roots the process-level half is unattributable and only the
 *   per-receipt half is checked.
 */
export function receiptInvariantMetrics(
	journal: EvalRunJournal | null,
	processExitCode: number,
): Record<string, number | boolean> {
	if (journal === null) return {};
	const sealed = journal.receiptFiles > 0;
	const roots = journal.receipts.filter(isRootReceipt);
	const base = { "receipt.count": journal.receiptFiles, "receipt.sealed": sealed, "receipt.rootCount": roots.length };
	if (!sealed) return base;
	return {
		...base,
		"receipt.integrityValid": integrityValid(journal),
		"receipt.outcomeMatchesExit": outcomeMatchesExit(journal, roots, processExitCode),
	};
}

function integrityValid(journal: EvalRunJournal): boolean {
	// A receipt file that did not parse never reaches the loop below, so the
	// count has to agree first: an unreadable seal cannot be authenticated.
	if (journal.receipts.length !== journal.receiptFiles) return false;
	return journal.receipts.every((receipt) => {
		const envelope = journal.envelopes.get(receipt.runId);
		// No envelope means no authority to verify against. The receipt is
		// unauthenticated, which is a failure and never an absence.
		if (envelope === undefined) return false;
		return verifyReceiptIntegrity(receipt, envelope).ok;
	});
}

function outcomeMatchesExit(
	journal: EvalRunJournal,
	roots: ReadonlyArray<RunReceipt>,
	processExitCode: number,
): boolean {
	if (journal.receipts.length !== journal.receiptFiles) return false;
	const selfConsistent = journal.receipts.every(
		(receipt) => (receipt.outcome === "succeeded") === (receipt.exitCode === 0),
	);
	if (!selfConsistent) return false;
	const root = roots.length === 1 ? roots[0] : undefined;
	if (root === undefined) return true;
	return (root.exitCode === 0) === (processExitCode === 0);
}

function isRootReceipt(receipt: RunReceipt): boolean {
	return receipt.lineage === undefined || receipt.lineage.rootRunId === receipt.runId;
}

function isReceiptShaped(value: unknown): value is RunReceipt {
	if (!isRecord(value)) return false;
	return (
		typeof value.runId === "string" &&
		typeof value.agentId === "string" &&
		typeof value.exitCode === "number" &&
		typeof value.outcome === "string" &&
		isRecord(value.integrity)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
