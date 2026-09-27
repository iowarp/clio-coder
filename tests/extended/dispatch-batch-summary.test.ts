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

test("parallel dispatch returns scheduler assignments on a board with no worker posts", async () => {
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { isolateClioEnv } = await import("../harness/scratch-env.js");
	const { runDispatchTool } = await import("../../src/tools/dispatch-runner.js");
	const { describeDispatchPlan } = await import("../../src/tools/dispatch-plan.js");
	const env = await isolateClioEnv("clio-settled-board-");
	try {
		const requests = ["Inspect entry points", "Inspect boundaries"].map((task) => ({
			agentId: "scout",
			executionRole: "researcher" as const,
			task,
		}));
		const envelopes: ReturnType<typeof fixtureEnvelope>[] = [];
		const dispatch = {
			async dispatchBatch(ledgered: ReadonlyArray<import("../../src/domains/dispatch/contract.js").DispatchRequest>) {
				const receipts = ledgered.map((request, index) => {
					const run = {
						...fixtureEnvelope(`board-${index}`),
						agentId: request.agentId,
						task: request.task,
						receiptPath: join(env.dir, `receipt-${index}.json`),
						projection: {
							version: 1 as const,
							ledgerId: request.ledger?.id ?? null,
							readRoots: [],
							writeRoots: [],
							scopeSource: "none" as const,
						},
					};
					const receipt = withReceiptIntegrity(fixtureReceiptDraft(run), run);
					envelopes.push(run);
					writeFileSync(run.receiptPath, JSON.stringify(receipt));
					return receipt;
				});
				return {
					batchId: "attached",
					assignmentIds: envelopes.map((run) => run.id),
					events: (async function* () {})(),
					finalPromise: Promise.resolve(receipts),
				};
			},
			getRun: (id: string) => envelopes.find((run) => run.id === id) ?? null,
			listRuns: () => envelopes,
			abort() {},
		} as unknown as import("../../src/domains/dispatch/contract.js").DispatchContract;
		const args = { mode: "parallel", tasks: requests.map((request) => ({ agent: request.agentId, task: request.task })) };
		const state: import("../../src/tools/dispatch-admission.js").DispatchAdmissionState = {
			preparedAdmissionArgs: new WeakSet(),
			trustedResolvedPlans: new WeakMap(),
			trustedReservationOwners: new WeakMap(),
			trustedExecutionSnapshots: new WeakMap(),
			trustedExecutionPlans: new WeakMap(),
			taskResolutions: new WeakMap(),
		};
		state.trustedExecutionSnapshots.set(args, {
			kind: "dispatch",
			planView: describeDispatchPlan(args),
			requests,
			mode: "parallel",
			writers: undefined,
			review: undefined,
			compete: undefined,
			council: undefined,
			detach: false,
			timeoutMs: undefined,
			maxOutputBytes: 16384,
		});
		const result = await runDispatchTool({ dispatch, getAgentSpecs: () => [], getAutonomy: () => "yolo" }, state, args);
		ok(result.kind === "ok", JSON.stringify(result));
		match(String(result.details?.agentLedgerBoard), /Assignments:[\s\S]*Inspect entry points[\s\S]*Inspect boundaries/u);
	} finally {
		env.restore();
	}
});
