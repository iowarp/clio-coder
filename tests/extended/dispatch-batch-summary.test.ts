import { deepStrictEqual, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { dispatchBatchSummary, formatDispatchOutput } from "../../src/tools/dispatch-runner.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function run(
	id: string,
	costUsd: number,
	provenance: "known" | "estimated" | "unknown",
	calls: number,
	external = false,
) {
	const envelope = { ...fixtureEnvelope(id), costUsd };
	const draft = fixtureReceiptDraft(envelope);
	draft.costProvenance = provenance;
	draft.toolCalls = calls;
	if (external) {
		draft.externalTelemetry = {
			tokenUsage: "unverified",
			cost: "missing",
			sessionId: null,
			exitReason: "stop",
			toolObservability: "unavailable",
		};
	}
	const receipt = withReceiptIntegrity(draft, envelope);
	const integrity = verifyReceiptIntegrity(receipt, envelope);
	ok(integrity.ok);
	return {
		receipt,
		receiptPath: null,
		integrity,
		summary: { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: id },
	};
}

test("dispatch batch shows sealed tool calls and provenance-aware cost without inventing external tool counts", () => {
	const first = run("run-a", 0.1, "known", 3);
	const second = run("run-b", 0.2, "estimated", 4);
	const opaque = run("run-c", 0, "unknown", 0, true);
	const fourth = run("run-d", 1, "known", 99);
	const tamperedReceipt = { ...fourth.receipt, task: "tampered" };
	const tampered = {
		...fourth,
		receipt: tamperedReceipt,
		integrity: verifyReceiptIntegrity(tamperedReceipt, { ...fixtureEnvelope("run-d"), costUsd: 1 }),
	};
	const runs = [first, second, opaque, tampered];
	deepStrictEqual(dispatchBatchSummary(runs), {
		observedToolCalls: 7,
		unobservableToolRuns: 1,
		excludedUntrustedRuns: 1,
		cost: "$0.30 +?",
	});
	match(
		formatDispatchOutput("parallel", runs, 16_384),
		/batch observed_tool_calls=7 cost=\$0\.30 \+\? unobservable_tool_runs=1 excluded_untrusted_runs=1/u,
	);
});
