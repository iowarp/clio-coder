/**
 * Receipt evidence that a writer produced and the dispatch domain then lost on
 * the way to the sealed receipt or the adopted ledger row: tool frames dropped
 * under bulk-lane backpressure, a spawn failure's own error text, and an
 * orphan's council and cost provenance.
 */
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { createBoundedEventQueue } from "../../src/domains/dispatch/worker-protocol.js";
import { spawnWorkerProcess } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

describe("bulk-lane backpressure", () => {
	it("keeps the tool frames the receipt fold reads above the queue bound", () => {
		const queue = createBoundedEventQueue(2);
		const evidence = [
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} },
			{ type: "clio_coder_tool_start", payload: { tool: "read", toolCallId: "call-1", posture: "operating" } },
			{
				type: "clio_coder_tool_finish",
				payload: { tool: "read", toolCallId: "call-1", posture: "operating", durationMs: 4, outcome: "ok" },
			},
		];
		queue.push({ type: "message_update", delta: "a" });
		queue.push({ type: "message_update", delta: "b" });
		for (const frame of evidence) {
			queue.push(frame);
			for (let index = 0; index < 4; index += 1) queue.push({ type: "message_update", delta: `${index}` });
		}
		const kept: unknown[] = [];
		while (queue.size > 0) kept.push(queue.shift());
		deepStrictEqual(
			kept.filter((frame) => (frame as { type: string }).type !== "message_update"),
			evidence,
		);
		ok(queue.stats().droppedDisplayFrames > 0, "the bound must still drop display frames");
	});
});

describe("spawn failure diagnostics", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("seal the spawn error's own text in the receipt", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		const missing = join(tmpdir(), "clio-coder-no-such-worker-binary");
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: (spec, options) => spawnWorkerProcess(missing, [], spec, options),
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "researcher",
				task: "Inspect isolated fixture evidence.",
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			});
			const receipt = await run.finalPromise;
			equal(receipt.outcome, "spawn_failed");
			match(receipt.outcomeDetail ?? "", /ENOENT/u);
			match(receipt.failureMessage ?? "", /ENOENT/u);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("orphan adoption", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("restores the council and cost provenance the receipt carries", () => {
		const council = { group: "council-7", label: "Design review", color: "cyan", round: 2 };
		const envelope: RunEnvelope = { ...fixtureEnvelope("orphan-council"), council, costProvenance: "known" };
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			council,
			costProvenance: "known",
			reproducibility: {
				cwd: envelope.cwd,
				git: { branch: null, commit: null, dirty: null, dirtyEntries: null, statusHash: null },
				safetyPolicy: {
					version: 1,
					rulePackHash: null,
					rulePackVersion: null,
					projectPolicyPath: null,
					projectPolicyHash: null,
					projectPolicyValid: null,
				},
			},
		};
		const receipt = withReceiptIntegrity(draft, envelope);
		const receipts = join(clioStateDir(), "receipts");
		mkdirSync(receipts, { recursive: true });
		writeFileSync(join(receipts, `${receipt.runId}.json`), JSON.stringify(receipt));

		const ledger = openLedger({ maxRuns: 10 });
		const summary = recoverOrphanReceipts(ledger);
		equal(summary.recovered, 1);
		const adopted = ledger.get(receipt.runId);
		ok(adopted);
		deepStrictEqual(adopted.council, council);
		equal(adopted.costProvenance, "known");
	});
});
