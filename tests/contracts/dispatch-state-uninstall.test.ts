/**
 * `clio-coder uninstall` removes the state root out from under processes that are
 * still holding a dispatch ledger. Every writer under the ledger mkdirs its
 * parent back (the state file lock before its critical section, `atomicWrite`
 * again for the temp file), so a persist landing a moment after the removal
 * recreated `$CLIO_CODER_STATE_DIR` with runs.json inside it: an uninstall that
 * reported success left a state home behind, and the next start read a ledger
 * out of a home that was supposed to be gone.
 */
import { ok, strictEqual } from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function draftFor(envelope: RunEnvelope): RunReceiptDraft {
	return {
		runId: envelope.id,
		agentId: envelope.agentId,
		executionRole: envelope.executionRole,
		task: envelope.task,
		targetId: envelope.targetId,
		wireModelId: envelope.wireModelId,
		runtimeId: envelope.runtimeId,
		runtimeKind: envelope.runtimeKind,
		startedAt: envelope.startedAt,
		endedAt: "2026-08-13T12:00:01.000Z",
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		tokenCount: 3,
		costUsd: 0,
		costProvenance: "unknown",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		sessionId: null,
	};
}

describe("contracts/dispatch state after an uninstall", () => {
	let scratch: ReturnType<typeof isolateClioEnv>;
	let stateDir: string;

	beforeEach(() => {
		scratch = isolateClioEnv("clio-dispatch-uninstall-");
		stateDir = join(scratch.dir, "state");
	});

	afterEach(() => {
		scratch.restore();
	});

	function newRun(): { ledger: ReturnType<typeof openLedger>; envelope: RunEnvelope } {
		const ledger = openLedger({ maxRuns: 20 });
		const envelope = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "a run that outlives its state root",
			targetId: "default",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: "/tmp/uninstall-project",
		});
		return { ledger, envelope };
	}

	it("does not write runs.json back into a state root that was removed", async () => {
		const { ledger } = newRun();
		await ledger.persist();
		ok(existsSync(join(stateDir, "runs.json")), "the ledger persists normally while the root is there");

		rmSync(stateDir, { recursive: true, force: true });
		await ledger.persist();

		strictEqual(existsSync(stateDir), false, "a persist must not recreate the state root an uninstall removed");
	});

	it("does not write a receipt back into a state root that was removed", () => {
		const { ledger, envelope } = newRun();
		rmSync(stateDir, { recursive: true, force: true });

		const sealed = ledger.recordReceipt(envelope.id, draftFor(envelope));

		strictEqual(sealed.runId, envelope.id, "the finalizer still gets its sealed receipt");
		strictEqual(existsSync(stateDir), false, "a receipt write must not recreate the state root an uninstall removed");
		strictEqual(ledger.get(envelope.id)?.receiptPath, null, "no receiptPath is claimed for a file that was not written");
	});

	// The guard is about a root that is gone. The ordinary path must still write.
	it("still writes runs.json and the receipt while the state root is present", async () => {
		const { ledger, envelope } = newRun();
		ledger.recordReceipt(envelope.id, draftFor(envelope));
		await ledger.persist();

		ok(existsSync(join(stateDir, "runs.json")), "runs.json is written on the ordinary path");
		ok(existsSync(join(stateDir, "receipts", `${envelope.id}.json`)), "the receipt is written on the ordinary path");
		strictEqual(ledger.get(envelope.id)?.receiptPath, join(stateDir, "receipts", `${envelope.id}.json`));
	});
});
