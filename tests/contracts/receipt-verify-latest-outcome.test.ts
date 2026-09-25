/**
 * BT-017. A worker ran `verify(check="test")`, it failed, the worker fixed the
 * code and ran the same check again, and it passed. The sealed receipt folded
 * both calls into one per-tool aggregate and kept the earlier failure:
 * `quality.typedValidations: [{sourceId: "tool:verify", passed: false}]`,
 * `verification: {state: "unverified", basis: "validation-tool"}`, and the
 * card read `quality validation failed` over a workspace whose tests pass.
 *
 * The receipt must reflect what each check last did. A later run of the same
 * check supersedes an earlier one in both directions, and "the same check" is
 * the check the call named, not the tool it went through.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { verifyCheckIdentity } from "../../src/domains/dispatch/receipt-findings.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

interface VerifyCall {
	args: Record<string, unknown>;
	outcome: "ok" | "error" | "blocked";
	/** Omit the call id, the way a runtime without engine call ids reports a finish. */
	anonymous?: boolean;
}

let callCounter = 0;

function verifyCallEvents(call: VerifyCall): unknown[] {
	callCounter += 1;
	const toolCallId = `verify-call-${callCounter}`;
	const id = call.anonymous === true ? {} : { toolCallId };
	return [
		{ type: "tool_execution_start", toolCallId, toolName: "verify", args: call.args },
		{ type: "clio_coder_tool_start", payload: { tool: "verify", ...id, posture: "operating", startedAt: Date.now() } },
		{
			type: "clio_coder_tool_finish",
			payload: { tool: "verify", ...id, posture: "operating", durationMs: 5, outcome: call.outcome },
		},
		{
			type: "tool_execution_end",
			toolCallId,
			toolName: "verify",
			isError: call.outcome !== "ok",
			result: { content: [{ type: "text", text: call.outcome }], details: {} },
		},
	];
}

async function sealedReceipt(calls: VerifyCall[]): Promise<RunReceipt> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: () => {
			const worker: SpawnedWorker = {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					for (const call of calls) yield* verifyCallEvents(call);
					yield {
						type: "message_end",
						message: { role: "assistant", stopReason: "stop", content: "Ran the checks." },
					};
				})(),
			};
			return worker;
		},
	});
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "tester",
			executionRole: "builder",
			task: "Add edge-case tests and run the test check.",
			requestOrigin: "internal",
		});
		const receipt = await run.finalPromise;
		const stored = bundle.contract.getRun(run.runId);
		ok(stored);
		deepStrictEqual(verifyReceiptIntegrity(receipt, stored), { ok: true });
		return receipt;
	} finally {
		await bundle.extension.stop?.();
	}
}

function verdicts(receipt: RunReceipt): boolean[] {
	return receipt.quality.typedValidations.map((fact) => fact.passed).sort();
}

describe("typed validation follows each check's latest run (BT-017)", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("a failed check that later passes seals as passed and verified", async () => {
		const receipt = await sealedReceipt([
			{ args: { check: "test" }, outcome: "error" },
			{ args: { check: "test" }, outcome: "ok" },
		]);
		equal(receipt.toolStats.find((stat) => stat.tool === "verify")?.errors, 1);
		deepStrictEqual(verdicts(receipt), [true]);
		ok(receipt.quality.typedValidations.every((fact) => fact.sourceId === "tool:verify"));
		deepStrictEqual(receipt.verification, { state: "verified", basis: "validation-tool" });
	});

	it("a passed check that later fails seals as failed", async () => {
		const receipt = await sealedReceipt([
			{ args: { check: "test" }, outcome: "ok" },
			{ args: { check: "test" }, outcome: "error" },
		]);
		deepStrictEqual(verdicts(receipt), [false]);
		deepStrictEqual(receipt.verification, { state: "unverified", basis: "validation-tool" });
	});

	it("a retry with more time or output room is the same check", async () => {
		const receipt = await sealedReceipt([
			{ args: { check: "test", timeout_ms: 1_000 }, outcome: "error" },
			{ args: { check: "test", timeout_ms: 60_000, max_output_bytes: 900_000 }, outcome: "ok" },
		]);
		deepStrictEqual(verdicts(receipt), [true]);
		equal(
			verifyCheckIdentity({ check: "test", args: '["a.js"]' }),
			verifyCheckIdentity({ check: "test", args: ["a.js"] }),
		);
	});

	it("a different check passing does not clear a failed one", async () => {
		const receipt = await sealedReceipt([
			{ args: { check: "test" }, outcome: "error" },
			{ args: { check: "lint" }, outcome: "ok" },
		]);
		deepStrictEqual(verdicts(receipt), [false, true]);
		deepStrictEqual(receipt.verification, { state: "unverified", basis: "validation-tool" });
	});

	it("a narrower run of the same script does not clear the full run's failure", async () => {
		const receipt = await sealedReceipt([
			{ args: { check: "test" }, outcome: "error" },
			{ args: { check: "test", args: ["test/calc.test.js"] }, outcome: "ok" },
		]);
		deepStrictEqual(verdicts(receipt), [false, true]);
		deepStrictEqual(receipt.verification, { state: "unverified", basis: "validation-tool" });
	});

	it("a frontend check on another artifact is another check", async () => {
		const receipt = await sealedReceipt([
			{ args: { check: "frontend", path: "site/a.html" }, outcome: "error" },
			{ args: { check: "frontend", path: "site/b.html" }, outcome: "ok" },
		]);
		deepStrictEqual(verdicts(receipt), [false, true]);
	});

	it("a blocked retry neither clears a failure nor overturns a pass", async () => {
		const failed = await sealedReceipt([
			{ args: { check: "test" }, outcome: "error" },
			{ args: { check: "test" }, outcome: "blocked" },
		]);
		deepStrictEqual(verdicts(failed), [false]);
		const passed = await sealedReceipt([
			{ args: { check: "test" }, outcome: "ok" },
			{ args: { check: "test" }, outcome: "blocked" },
		]);
		deepStrictEqual(verdicts(passed), [true]);
		const neverRan = await sealedReceipt([{ args: { check: "test" }, outcome: "blocked" }]);
		deepStrictEqual(verdicts(neverRan), [false]);
	});

	it("a finish that cannot be tied to its check keeps the conservative aggregate", async () => {
		const receipt = await sealedReceipt([
			{ args: { check: "test" }, outcome: "error", anonymous: true },
			{ args: { check: "test" }, outcome: "ok", anonymous: true },
		]);
		deepStrictEqual(verdicts(receipt), [false]);
		deepStrictEqual(receipt.verification, { state: "unverified", basis: "validation-tool" });
	});
});
