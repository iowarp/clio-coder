/**
 * Read back what a test run left under its scratch state directory: the run
 * ledger with its sealed receipts, and the session ledger entries. Tests that
 * drive the real orchestrator or CLI assert against these durable records
 * rather than against the process's own report of what it did.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { listSessionLedgerRefs, parseSessionEntries } from "../../src/domains/session/archive-readers.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";

export interface RunJournal {
	/** Ledger envelopes by run id, the authority a receipt is authenticated against. */
	envelopes: Map<string, RunEnvelope>;
	/** Receipts that parsed into receipt shape. */
	receipts: RunReceipt[];
}

/** The run ledger and receipts under `stateDir`, or null when the directory does not exist. */
export function readRunJournal(stateDir: string): RunJournal | null {
	if (!existsSync(stateDir)) return null;
	return { envelopes: readEnvelopes(join(stateDir, "runs.json")), receipts: readReceipts(join(stateDir, "receipts")) };
}

/** Every entry of every session ledger under `stateDir`, in ledger order. */
export async function readSessionLedgerEntries(stateDir: string): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = [];
	for (const ref of await listSessionLedgerRefs(stateDir)) {
		entries.push(...parseSessionEntries(await readFile(ref.path, "utf8"), ref.path).entries);
	}
	return entries;
}

function readEnvelopes(runsPath: string): Map<string, RunEnvelope> {
	const envelopes = new Map<string, RunEnvelope>();
	if (!existsSync(runsPath)) return envelopes;
	const parsed: unknown = JSON.parse(readFileSync(runsPath, "utf8"));
	if (!Array.isArray(parsed)) return envelopes;
	for (const entry of parsed) {
		if (isRecord(entry) && typeof entry.id === "string") envelopes.set(entry.id, entry as unknown as RunEnvelope);
	}
	return envelopes;
}

function readReceipts(receiptsDir: string): RunReceipt[] {
	if (!existsSync(receiptsDir)) return [];
	const receipts: RunReceipt[] = [];
	for (const name of readdirSync(receiptsDir).filter((entry) => entry.endsWith(".json"))) {
		const parsed: unknown = JSON.parse(readFileSync(join(receiptsDir, name), "utf8"));
		if (isReceiptShaped(parsed)) receipts.push(parsed);
	}
	return receipts;
}

function isReceiptShaped(value: unknown): value is RunReceipt {
	return (
		isRecord(value) &&
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
