/**
 * The one resolver every receipt reader goes through (#434, decision 5b a).
 *
 * Receipt pruning is opt-in, and replaces `<state>/receipts/<runId>.json` only
 * when the run's evidence bundle holds a copy that verifies against the seal.
 * The file left in its place is a tombstone naming that bundle and the seal
 * digest, so a reader keeps the path it always read and gets the receipt back
 * from the copy. A copy that no longer holds the receipt under the same digest
 * reads as a missing receipt, never as a different one.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import { clioDataDir } from "../../core/xdg.js";

export const RECEIPT_TOMBSTONE_FORMAT = "clio-receipt-tombstone/1";

export interface ReceiptTombstone {
	format: typeof RECEIPT_TOMBSTONE_FORMAT;
	runId: string;
	/** The evidence bundle whose `receipt.json` holds the verified copy. */
	evidenceId: string;
	/** The seal digest the copy carries, so a changed copy never stands in for the pruned receipt. */
	digest: string;
	prunedAt: string;
}

function isReceiptTombstone(value: unknown): value is ReceiptTombstone {
	if (!value || typeof value !== "object") return false;
	const tombstone = value as Partial<ReceiptTombstone>;
	return (
		tombstone.format === RECEIPT_TOMBSTONE_FORMAT &&
		typeof tombstone.runId === "string" &&
		typeof tombstone.evidenceId === "string" &&
		/^[a-zA-Z0-9_-]+$/.test(tombstone.evidenceId) &&
		typeof tombstone.digest === "string" &&
		typeof tombstone.prunedAt === "string"
	);
}

/** Where a run's evidence bundle keeps the receipts it verified. */
export function evidenceReceiptCopyPath(evidenceId: string, dataDir = clioDataDir()): string {
	assertSafeId(evidenceId, "evidence");
	return join(dataDir, "evidence", evidenceId, "receipt.json");
}

/** The tombstone a receipt file holds, or null for a receipt; most receipts skip the parse. */
export function receiptTombstoneOf(text: string): ReceiptTombstone | null {
	if (!text.includes(RECEIPT_TOMBSTONE_FORMAT)) return null;
	try {
		const value: unknown = JSON.parse(text);
		return isReceiptTombstone(value) ? value : null;
	} catch {
		// A file that does not parse is no tombstone; its reader reports it as the receipt it claims to be.
		return null;
	}
}

/** The pruned receipt from its evidence copy's text, or null when the copy no longer holds it under the same seal. */
export function receiptFromEvidenceCopy(
	tombstone: ReceiptTombstone,
	copyText: string | null,
): Record<string, unknown> | null {
	if (copyText === null) return null;
	let copy: unknown;
	try {
		copy = JSON.parse(copyText);
	} catch {
		// A torn evidence copy holds nothing to stand in for the receipt.
		return null;
	}
	const receipts = (copy as { receipts?: unknown } | null)?.receipts;
	if (!Array.isArray(receipts)) return null;
	for (const receipt of receipts) {
		const entry = receipt as { runId?: unknown; integrity?: { digest?: unknown } } | null;
		if (entry?.runId === tombstone.runId && entry.integrity?.digest === tombstone.digest)
			return receipt as Record<string, unknown>;
	}
	return null;
}

function prunedReceiptMissing(tombstone: ReceiptTombstone): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(
		`receipt ${tombstone.runId} was pruned and evidence ${tombstone.evidenceId} no longer holds it under its seal`,
	);
	error.code = "ENOENT";
	return error;
}

/**
 * A receipt's JSON text at `path`, following a pruned receipt's tombstone to its evidence copy. Throws as
 * `readFileSync` does; a tombstone whose copy is gone throws ENOENT, as a missing receipt does.
 */
export function readReceiptTextSync(path: string, dataDir?: string): string {
	const text = readFileSync(path, "utf8");
	const tombstone = receiptTombstoneOf(text);
	if (tombstone === null) return text;
	let copy: string | null;
	try {
		copy = readFileSync(evidenceReceiptCopyPath(tombstone.evidenceId, dataDir), "utf8");
	} catch {
		// No copy left to read: the pruned receipt reads as missing below.
		copy = null;
	}
	const receipt = receiptFromEvidenceCopy(tombstone, copy);
	if (receipt === null) throw prunedReceiptMissing(tombstone);
	return JSON.stringify(receipt);
}

/** The asynchronous {@link readReceiptTextSync}. */
export async function readReceiptText(path: string, dataDir?: string): Promise<string> {
	const text = await readFile(path, "utf8");
	const tombstone = receiptTombstoneOf(text);
	if (tombstone === null) return text;
	const copy = await readFile(evidenceReceiptCopyPath(tombstone.evidenceId, dataDir), "utf8").catch(() => null);
	const receipt = receiptFromEvidenceCopy(tombstone, copy);
	if (receipt === null) throw prunedReceiptMissing(tombstone);
	return JSON.stringify(receipt);
}
