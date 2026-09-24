import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { cloneRunToolBudgetEnvelope, resolveToolBudgetEnvelope } from "../../src/domains/dispatch/budget-envelope.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const baseline = {
	recipeId: "scout",
	policy: { toolCalls: 18, readReserve: 4, synthesis: true },
	hardCap: 150,
	hasReadTool: true,
	retry: false,
	revision: false,
	enforcement: "native-per-tool" as const,
	nativeReadOnlyResearch: true,
};

test("native research locks after call 36 while keeping the hard cap and truthful envelope", () => {
	const envelope = resolveToolBudgetEnvelope(baseline);
	equal(envelope.effective.mode, "enforced");
	equal(envelope.effective.toolCalls, 36);
	equal(envelope.effective.hardCap, 150);
	equal(envelope.enforcement.perTool, "enforced");
	ok(envelope.reasons.some((reason) => reason.code === "read-only-research-synthesis"));
	deepStrictEqual(cloneRunToolBudgetEnvelope(JSON.parse(JSON.stringify(envelope))), envelope);
	let synthesisLocks = 0;
	const guard = createLoopGuardRegistration({
		safety: createWorkerSafety(),
		toolCallCap: envelope.effective.hardCap,
		toolCallSoftLimit: envelope.effective.toolCalls,
		toolBudgetAdvisory: false,
		turnSynthesisLockout: true,
		onSynthesisLockout: () => synthesisLocks++,
	});
	for (let i = 1; i <= 36; i++) {
		const effects = guard.evaluate({
			hook: "before_tool",
			toolName: ToolNames.Read,
			toolArgs: { path: `source-${i}.ts` },
			metadata: { callFingerprint: `read-${i}` },
		});
		ok(!effects.some((effect) => effect.kind === "block_tool"), `call ${i} should be admitted`);
		equal(synthesisLocks, i < 36 ? 0 : 1);
	}
	ok(
		guard
			.evaluate({
				hook: "before_tool",
				toolName: ToolNames.Read,
				toolArgs: { path: "source-37.ts" },
				metadata: { callFingerprint: "read-37" },
			})
			.some((effect) => effect.kind === "block_tool"),
	);
	equal(synthesisLocks, 1);
	const lowerCap = resolveToolBudgetEnvelope({ ...baseline, hardCap: 30 });
	equal(lowerCap.effective.toolCalls, 30);
	equal(lowerCap.effective.hardCap, 30);
});

test("coding and external workers retain advisory per-tool behavior", () => {
	const coding = resolveToolBudgetEnvelope({ ...baseline, recipeId: "coder", nativeReadOnlyResearch: false });
	equal(coding.effective.mode, "advisory");
	equal(coding.effective.toolCalls, 18);
	const external = resolveToolBudgetEnvelope({ ...baseline, enforcement: "external-one-shot" });
	equal(external.effective.mode, "advisory");
	equal(external.enforcement.classification, "external-one-shot");
	equal(external.effective.toolCalls, 18);
});

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

for (const agentId of ["scout", "provenance"] as const) {
	test(`successful native ${agentId} receipt records the synthesis threshold without a failure outcome`, async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		let launchedBudget: unknown;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: (spec) => {
				launchedBudget = spec.budget;
				return {
					pid: null,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => {},
					events: (async function* () {
						for (let i = 0; i < 36; i++) {
							yield { type: "clio_coder_tool_finish", payload: { tool: "read", outcome: "ok", durationMs: 1 } };
						}
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "stop",
								content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
							},
						};
					})(),
				};
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId,
				task: "Inspect fixture evidence.",
				executionRole: "researcher",
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			});
			const receipt = await run.finalPromise;
			equal(receipt.outcome, "succeeded");
			equal(receipt.outcomeCode, null);
			equal(receipt.toolCalls, 36);
			equal((launchedBudget as { mode: string; toolCalls: number }).mode, "enforced");
			equal((launchedBudget as { mode: string; toolCalls: number }).toolCalls, 36);
			equal(receipt.budget?.effective.toolCalls, 36);
			equal(receipt.budget?.enforcement.perTool, "enforced");
			const stored = bundle.contract.getRun(run.runId);
			ok(stored);
			equal(verifyReceiptIntegrity(receipt, stored).ok, true);
		} finally {
			await bundle.extension.stop?.();
		}
	});
}
