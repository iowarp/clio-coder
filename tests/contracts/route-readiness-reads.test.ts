import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, renameSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { gateDecisionsDirectory } from "../../src/domains/dispatch/gate-decisions.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { createRouteHistoryStore, ROUTE_HISTORY_VERSION } from "../../src/domains/dispatch/route-history.js";
import { createRouteObserver } from "../../src/domains/dispatch/route-observer.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function hash(seed: string): string {
	return createHash("sha256").update(seed, "utf8").digest("hex");
}

const ROUTE: RouteCandidate = {
	agentId: "coder",
	specFingerprint: hash("spec"),
	executionRole: "builder",
	targetId: "local",
	modelId: "model-a",
	runtimeId: "openai",
	nodeId: "local",
	thinkingLevel: "off",
	toolSignature: hash("tools"),
	promptCompositionHash: hash("prompt"),
	endpointIdentityHash: hash("endpoint"),
	settingsFingerprint: hash("settings"),
};

/** Every durable write in the dispatch domain is tmp-and-rename; the fixture writes the same way. */
function writeRenamed(path: string, body: string): void {
	writeFileSync(`${path}.tmp`, body);
	renameSync(`${path}.tmp`, path);
}

function sealed(runId: string, passed: boolean): { envelope: RunEnvelope; receipt: RunReceipt } {
	const envelope = fixtureEnvelope(runId);
	const draft = fixtureReceiptDraft(envelope);
	draft.quality.typedValidations = [{ sourceId: "typed", validatorDigest: hash("validator"), passed }];
	return { envelope, receipt: withReceiptIntegrity(draft, envelope) };
}

function ledger(stateDir: string, runs: ReadonlyArray<{ envelope: RunEnvelope; receipt: RunReceipt }>): void {
	mkdirSync(join(stateDir, "receipts"), { recursive: true });
	for (const run of runs)
		writeRenamed(join(stateDir, "receipts", `${run.envelope.id}.json`), JSON.stringify(run.receipt));
	writeRenamed(join(stateDir, "runs.json"), JSON.stringify(runs.map((run) => run.envelope)));
}

/**
 * Count real `readFileSync` calls under the state directory's ledger, receipt
 * and gate paths. Patching the module object and re-syncing the builtin's ESM
 * bindings reaches every importer, so the count holds for any implementation.
 */
function countLedgerReads(stateDir: string): { reads: string[]; restore: () => void } {
	const reads: string[] = [];
	const original = fs.readFileSync;
	const tracked = (path: unknown): boolean =>
		typeof path === "string" &&
		path.startsWith(stateDir) &&
		(path.endsWith("runs.json") || path.includes("/receipts/") || path.includes("/gate-decisions/"));
	fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
		if (tracked(path)) reads.push(path as string);
		return (original as (...args: unknown[]) => unknown)(path, ...rest);
	}) as typeof fs.readFileSync;
	syncBuiltinESMExports();
	return {
		reads,
		restore() {
			fs.readFileSync = original;
			syncBuiltinESMExports();
		},
	};
}

describe("contracts/route readiness reads", () => {
	it("a dispatch reads only the receipts written since the previous one", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-reads-"));
		const runs = Array.from({ length: 12 }, (_, index) => sealed(`run-${index}`, true));
		ledger(stateDir, runs);
		const { reads, restore } = countLedgerReads(stateDir);
		after(restore);
		const observer = createRouteObserver({ stateDir, logDir: join(stateDir, "route-decisions") });

		// Each check takes the reads since the previous one.
		const drain = (): string[] => reads.splice(0).sort();

		observer.readinessWindow();
		strictEqual(drain().length, 13, "the first window reads runs.json and all twelve receipts");

		observer.readinessWindow();
		observer.readinessWindow();
		deepStrictEqual(drain(), [], "an unchanged ledger costs no file reads");

		const added = sealed("run-12", true);
		runs.push(added);
		writeRenamed(join(stateDir, "receipts", "run-12.json"), JSON.stringify(added.receipt));
		writeRenamed(join(stateDir, "runs.json"), JSON.stringify(runs.map((run) => run.envelope)));
		observer.readinessWindow();
		deepStrictEqual(drain(), [join(stateDir, "receipts", "run-12.json"), join(stateDir, "runs.json")].sort());

		// A rewrite of an existing receipt lands on a new inode and is read again.
		writeRenamed(join(stateDir, "receipts", "run-3.json"), JSON.stringify(runs[3]?.receipt));
		observer.readinessWindow();
		deepStrictEqual(drain(), [join(stateDir, "receipts", "run-3.json")]);

		const gates = gateDecisionsDirectory(stateDir);
		mkdirSync(gates, { recursive: true });
		writeRenamed(join(gates, "g-1.json"), JSON.stringify({ kind: "not-a-verifiable-artifact" }));
		observer.readinessWindow();
		deepStrictEqual(drain(), [join(gates, "g-1.json")], "a new gate artifact is the only read");
		observer.readinessWindow();
		deepStrictEqual(drain(), [], "a rejected gate artifact is not re-read either");
	});

	it("an unchanged ledger leaves route history untouched after reconciliation", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-history-"));
		const run = sealed("run-a", true);
		ledger(stateDir, [run]);
		createRouteHistoryStore({ stateDir }).upsert({
			version: ROUTE_HISTORY_VERSION,
			receiptDigest: run.receipt.integrity.digest,
			assignmentId: "assignment-a",
			route: ROUTE,
			executionRole: "builder",
			qualityLabel: "unmeasured",
			reliability: "success",
			firstPass: true,
			completedCostUsd: 0.01,
			completedPhaseTiming: null,
			cacheRead: false,
			sourceDigests: [run.receipt.integrity.digest],
			settledAt: "2026-06-25T12:00:05.000Z",
		});
		const historyPath = join(stateDir, "route-history.json");
		const observer = createRouteObserver({ stateDir, logDir: join(stateDir, "route-decisions") });

		observer.readinessWindow();
		const reconciled = statSync(historyPath);
		strictEqual(createRouteHistoryStore({ stateDir }).all()[0]?.qualityLabel, "pass");
		observer.readinessWindow();
		observer.readinessWindow();
		const after = statSync(historyPath);
		deepStrictEqual([after.ino, after.mtimeMs], [reconciled.ino, reconciled.mtimeMs], "no rewrite without new evidence");
	});

	it("a receipt rewritten in place is verified again, never trusted from the cache", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-readiness-tamper-"));
		const run = sealed("run-t", true);
		ledger(stateDir, [run]);
		createRouteHistoryStore({ stateDir }).upsert({
			version: ROUTE_HISTORY_VERSION,
			receiptDigest: run.receipt.integrity.digest,
			assignmentId: "assignment-t",
			route: ROUTE,
			executionRole: "builder",
			qualityLabel: "unmeasured",
			reliability: "success",
			firstPass: true,
			completedCostUsd: 0.01,
			completedPhaseTiming: null,
			cacheRead: false,
			sourceDigests: [run.receipt.integrity.digest],
			settledAt: "2026-06-25T12:00:05.000Z",
		});
		const observer = createRouteObserver({ stateDir, logDir: join(stateDir, "route-decisions") });
		observer.readinessWindow();
		strictEqual(createRouteHistoryStore({ stateDir }).all()[0]?.qualityLabel, "pass");

		// Same digest, altered body: a forged receipt claiming a verified identity.
		const forged = { ...run.receipt, task: "a different task" };
		writeRenamed(join(stateDir, "receipts", "run-t.json"), JSON.stringify(forged));
		observer.readinessWindow();
		strictEqual(createRouteHistoryStore({ stateDir }).all()[0]?.qualityLabel, "unmeasured");
	});
});
