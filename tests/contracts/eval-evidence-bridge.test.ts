import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { evidenceMetricsFromReceipt, receiptFromRunJsonStdout } from "../../src/domains/eval/metrics/evidence.js";
import { validateEvalSuiteV2 } from "../../src/domains/eval/schema/validate.js";
import { resultCostUsd } from "../../src/domains/eval/suites/run.js";

function receipt(partial: Partial<RunReceipt> = {}): RunReceipt {
	return {
		runId: "run-1",
		agentId: "scout",
		executionRole: "builder",
		task: "map the dispatch domain",
		targetId: "local",
		wireModelId: "model-a",
		runtimeId: "runtime-a",
		runtimeKind: "subprocess",
		startedAt: "2026-07-12T12:00:00.000Z",
		endedAt: "2026-07-12T12:00:05.000Z",
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		tokenCount: 42,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.2.8-test",
		piMonoVersion: "0.79.1",
		platform: "linux",
		nodeVersion: "v22.19.0",
		toolCalls: 3,
		toolStats: [],
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		sessionId: null,
		integrity: { version: 19, algorithm: "sha256", digest: "d".repeat(64) },
		...partial,
	} as RunReceipt;
}

describe("contracts/eval evidence bridge", () => {
	it("extracts the sealed receipt printed after the JSONL event stream", () => {
		const sealed = receipt({ verification: { state: "not_applicable", basis: "read-only-agent" } });
		const stdout = [
			JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
			JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: false }),
			"",
			JSON.stringify(sealed, null, 2),
			"",
		].join("\n");
		const parsed = receiptFromRunJsonStdout(stdout);
		ok(parsed !== null, "receipt tail must parse");
		strictEqual(parsed.runId, "run-1");
		deepStrictEqual(parsed.verification, { state: "not_applicable", basis: "read-only-agent" });
	});

	it("fails closed to null when no receipt block exists or the tail is malformed", () => {
		strictEqual(receiptFromRunJsonStdout(""), null);
		strictEqual(receiptFromRunJsonStdout(JSON.stringify({ type: "agent_end", messages: [] })), null);
		// A truncated pretty block is not a receipt.
		const truncated = `${JSON.stringify(receipt(), null, 2).slice(0, 120)}\n`;
		strictEqual(receiptFromRunJsonStdout(`{"type":"message_end"}\n${truncated}`), null);
		// An object that parses but lacks the receipt's load-bearing fields is
		// rejected rather than promoted.
		strictEqual(receiptFromRunJsonStdout('\n{\n  "runId": "x"\n}\n'), null);
	});

	it("derives evidence metrics from the receipt fields, never inventing values", () => {
		deepStrictEqual(
			evidenceMetricsFromReceipt(
				receipt({
					verification: { state: "verified", basis: "validation-tool" },
					findingsSummary: { tags: [], firstPassSuccess: true, findingCount: 0 },
					costUsd: 0.042,
				}),
			),
			{
				"evidence.verification": "verified",
				"evidence.firstPassSuccess": true,
				"evidence.quality.typedValidationCount": 0,
				"evidence.responseSchema.digest": "none",
				"cost.usd": 0.042,
			},
		);
		// A receipt with no findings summary omits firstPassSuccess (never defaults
		// it) so a gate on that metric fails closed rather than reading as success.
		const unverified = evidenceMetricsFromReceipt(
			receipt({ verification: { state: "unverified", basis: "no-validation-tool" } }),
		);
		strictEqual(unverified["evidence.verification"], "unverified");
		ok(!("evidence.firstPassSuccess" in unverified));
	});

	it("accepts the clio-run agent field and the matrix cost ceiling; rejects misuse", () => {
		const base = {
			version: 2,
			suite: { id: "evidence", title: "Evidence", visibility: "local" },
			matrix: { targets: [{ id: "local" }], repeats: 1, maxCostUsd: 0.5 },
			tasks: [
				{
					id: "recon",
					tags: ["live"],
					workspace: { kind: "local", path: "." },
					runner: { kind: "clio-run", agent: "scout", prompt: "map the repo" },
					verify: { assertions: [{ metric: "evidence.verification", op: "eq", value: "not_applicable" }] },
					metrics: { collect: ["evidence.verification", "cost.usd"] },
					timeoutMs: 120000,
				},
			],
		};
		const valid = validateEvalSuiteV2(base);
		strictEqual(valid.valid, true, JSON.stringify(valid));
		if (valid.valid) {
			strictEqual(valid.suite.matrix.maxCostUsd, 0.5);
			strictEqual(valid.suite.tasks[0]?.runner.agent, "scout");
		}

		const wrongRunner = validateEvalSuiteV2({
			...base,
			tasks: [
				{
					...base.tasks[0],
					runner: { kind: "external-command", agent: "scout", commands: ["true"] },
				},
			],
		});
		strictEqual(wrongRunner.valid, false);
		if (!wrongRunner.valid) {
			ok(wrongRunner.issues.some((issue) => issue.path === "$.tasks[0].runner.agent"));
		}

		const badBudget = validateEvalSuiteV2({
			...base,
			matrix: { targets: [{ id: "local" }], repeats: 1, maxCostUsd: -1 },
		});
		strictEqual(badBudget.valid, false);
		if (!badBudget.valid) {
			ok(badBudget.issues.some((issue) => issue.path === "$.matrix.maxCostUsd"));
		}
	});

	it("folds only known finite receipt cost into the matrix budget", () => {
		strictEqual(resultCostUsd({ metrics: { "cost.usd": 0.25 } }), 0.25);
		strictEqual(resultCostUsd({ metrics: {} }), 0);
		strictEqual(resultCostUsd({ metrics: { "cost.usd": Number.NaN } }), 0);
		strictEqual(resultCostUsd({ metrics: { "cost.usd": "0.25" } }), 0);
	});
});
