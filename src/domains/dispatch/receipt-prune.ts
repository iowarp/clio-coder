/**
 * Opt-in receipt pruning (#434, decision 5b a).
 *
 * A receipt is pruned only when the run's evidence bundle holds a copy under
 * the same seal digest and that copy verifies, against the run's ledger row
 * while the ring holds it. The receipt file then becomes a tombstone that
 * `readReceiptTextSync` follows back to the copy, so no reader loses the
 * receipt. Anything less leaves the receipt where it is and says why.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioDataDir, clioStateDir } from "../../core/xdg.js";
import { verifyReceiptIntegrityOutcome } from "../evidence/trust-status.js";
import { readEvidenceIndex } from "../observability/evidence-index.js";
import { isOpenRunRow } from "./orphan-recovery.js";
import type { ReceiptTombstone } from "./receipt-store.js";
import {
	evidenceReceiptCopyPath,
	RECEIPT_TOMBSTONE_FORMAT,
	receiptFromEvidenceCopy,
	receiptTombstoneOf,
} from "./receipt-store.js";
import type { RunEnvelope, RunReceipt } from "./types.js";

export interface ReceiptPruneAction {
	runId: string;
	path: string;
	bytes: number;
	evidenceId: string;
	digest: string;
}

export interface ReceiptPruneHold {
	runId: string;
	path: string;
	reason: "open-run" | "unsealed" | "unreadable" | "no-evidence-copy" | "copy-unverified";
}

export interface ReceiptPrunePlan {
	stateDir: string;
	dataDir: string;
	prune: ReceiptPruneAction[];
	held: ReceiptPruneHold[];
}

function readRows(stateDir: string): Map<string, RunEnvelope> {
	try {
		const rows: unknown = JSON.parse(readFileSync(join(stateDir, "runs.json"), "utf8"));
		return new Map(
			(Array.isArray(rows) ? rows : []).flatMap((row) =>
				row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
					? [[(row as RunEnvelope).id, row as RunEnvelope]]
					: [],
			),
		);
	} catch {
		// No readable ledger: every copy verifies on its seal alone, as for an evicted row.
		return new Map();
	}
}

/** The evidence bundle whose copy of this receipt verifies under its seal, newest first, or why none does. */
function verifiedCopy(
	receipt: RunReceipt,
	row: RunEnvelope | null,
	evidenceIds: readonly string[],
	dataDir: string,
): string | "no-evidence-copy" | "copy-unverified" {
	let found = false;
	const tombstone: ReceiptTombstone = {
		format: RECEIPT_TOMBSTONE_FORMAT,
		runId: receipt.runId,
		evidenceId: "",
		digest: receipt.integrity.digest,
		prunedAt: "",
	};
	for (const evidenceId of evidenceIds) {
		let text: string | null;
		try {
			text = readFileSync(evidenceReceiptCopyPath(evidenceId, dataDir), "utf8");
		} catch {
			// This bundle holds no readable copy; an older one may.
			text = null;
		}
		const copy = receiptFromEvidenceCopy({ ...tombstone, evidenceId }, text);
		if (copy === null) continue;
		found = true;
		try {
			if (verifyReceiptIntegrityOutcome(copy as unknown as RunReceipt, row).ok) return evidenceId;
		} catch {
			// A copy the verifier cannot read is no copy to prune against.
		}
	}
	return found ? "copy-unverified" : "no-evidence-copy";
}

/** Every receipt that may become a tombstone, and every one that stays with the reason; nothing is written. */
export function planReceiptPrune(stateDir = clioStateDir(), dataDir = clioDataDir()): ReceiptPrunePlan {
	const plan: ReceiptPrunePlan = { stateDir, dataDir, prune: [], held: [] };
	let names: string[];
	try {
		names = readdirSync(join(stateDir, "receipts"))
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch {
		// No receipts directory: nothing to prune.
		return plan;
	}
	const rows = readRows(stateDir);
	const evidence = new Map<string, string[]>();
	for (const row of [...readEvidenceIndex(stateDir)].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)))
		evidence.set(row.runId, [...(evidence.get(row.runId) ?? []), row.evidenceId]);
	for (const name of names) {
		const runId = name.slice(0, -".json".length);
		const path = join(stateDir, "receipts", name);
		let text: string;
		let receipt: RunReceipt;
		try {
			text = readFileSync(path, "utf8");
			if (receiptTombstoneOf(text) !== null) continue;
			receipt = JSON.parse(text) as RunReceipt;
		} catch {
			plan.held.push({ runId, path, reason: "unreadable" });
			continue;
		}
		const row = rows.get(runId) ?? null;
		if (row !== null && isOpenRunRow(row)) {
			plan.held.push({ runId, path, reason: "open-run" });
			continue;
		}
		if (receipt?.runId !== runId || typeof receipt.integrity?.digest !== "string") {
			plan.held.push({ runId, path, reason: "unsealed" });
			continue;
		}
		const copy = verifiedCopy(receipt, row, evidence.get(runId) ?? [], dataDir);
		if (copy === "no-evidence-copy" || copy === "copy-unverified") {
			plan.held.push({ runId, path, reason: copy });
			continue;
		}
		plan.prune.push({ runId, path, bytes: Buffer.byteLength(text), evidenceId: copy, digest: receipt.integrity.digest });
	}
	return plan;
}

export interface ReceiptPruneResult {
	pruned: ReceiptPruneAction[];
	skipped: Array<{ path: string; reason: string }>;
}

/** Replace each planned receipt with its tombstone, after checking again that its copy still verifies. */
export function applyReceiptPrune(plan: ReceiptPrunePlan, now: () => Date = () => new Date()): ReceiptPruneResult {
	const result: ReceiptPruneResult = { pruned: [], skipped: [] };
	const fresh = new Map(planReceiptPrune(plan.stateDir, plan.dataDir).prune.map((action) => [action.path, action]));
	for (const action of plan.prune) {
		const current = fresh.get(action.path);
		if (!current || current.digest !== action.digest || current.evidenceId !== action.evidenceId) {
			result.skipped.push({ path: action.path, reason: "changed since the plan" });
			continue;
		}
		const tombstone: ReceiptTombstone = {
			format: RECEIPT_TOMBSTONE_FORMAT,
			runId: action.runId,
			evidenceId: action.evidenceId,
			digest: action.digest,
			prunedAt: now().toISOString(),
		};
		safeResourceWrite(action.path, `${JSON.stringify(tombstone, null, 2)}\n`);
		result.pruned.push(action);
	}
	return result;
}
