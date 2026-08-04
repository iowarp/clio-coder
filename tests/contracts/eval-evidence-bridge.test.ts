import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import {
	dispatchCountFromJsonl,
	evidenceMetricsFromReceipt,
	receiptFromRunJsonStdout,
	scoutDispatchCountFromJsonl,
	wikiStaleAcknowledgedFromJsonl,
} from "../../src/domains/eval/metrics/evidence.js";
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
		integrity: { version: 14, algorithm: "sha256", digest: "d".repeat(64) },
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

	it("counts terminal dispatch tool calls with the canonical-stream preference", () => {
		strictEqual(dispatchCountFromJsonl(""), 0);
		const executionEnds = [
			JSON.stringify({ type: "tool_execution_end", toolCallId: "d1", toolName: "dispatch", isError: false }),
			JSON.stringify({ type: "tool_execution_end", toolCallId: "d1", toolName: "dispatch", isError: false }),
			JSON.stringify({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", isError: false }),
		].join("\n");
		strictEqual(dispatchCountFromJsonl(executionEnds), 1, "duplicate ids and non-dispatch tools do not count");
		// When the canonical clio finish stream exists it is authoritative,
		// even when it reports zero dispatches.
		const canonicalZero = [
			JSON.stringify({ type: "tool_execution_end", toolCallId: "d1", toolName: "dispatch", isError: false }),
			JSON.stringify({ type: "clio_tool_finish", payload: { tool: "read", outcome: "ok" } }),
		].join("\n");
		strictEqual(dispatchCountFromJsonl(canonicalZero), 0);
		const canonicalTwo = [
			JSON.stringify({ type: "clio_tool_finish", payload: { tool: "dispatch", outcome: "ok", toolCallId: "a" } }),
			JSON.stringify({ type: "clio_tool_finish", payload: { tool: "dispatch", outcome: "ok", toolCallId: "b" } }),
		].join("\n");
		strictEqual(dispatchCountFromJsonl(canonicalTwo), 2);
	});

	it("counts only model-authored dispatch starts that actually target Scout", () => {
		const stdout = [
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "s1",
				toolName: "dispatch",
				args: { tasks: [{ agent: "scout", task: "map the repo" }] },
			}),
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "s1",
				toolName: "dispatch",
				args: { tasks: [{ agent: "scout", task: "duplicate" }] },
			}),
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "dispatch",
				args: { agent: "coder", tasks: ["implement"] },
			}),
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "s2",
				toolName: "dispatch",
				args: { agent_id: "scout", tasks: JSON.stringify(["inspect one domain"]) },
			}),
		].join("\n");
		strictEqual(scoutDispatchCountFromJsonl(stdout), 2);
		strictEqual(scoutDispatchCountFromJsonl(""), 0);
	});

	it("acknowledges wiki staleness only for a source read after a wiki lookup", () => {
		const wikiThenRead = [
			JSON.stringify({ type: "tool_execution_start", toolCallId: "w1", toolName: "code_nav", args: { mode: "wiki" } }),
			JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "src/a.ts" } }),
		].join("\n");
		strictEqual(wikiStaleAcknowledgedFromJsonl(wikiThenRead), true);
		const readThenWiki = [
			JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "src/a.ts" } }),
			JSON.stringify({ type: "tool_execution_start", toolCallId: "w1", toolName: "code_nav", args: { mode: "wiki" } }),
		].join("\n");
		strictEqual(wikiStaleAcknowledgedFromJsonl(readThenWiki), false, "a pre-wiki read is not acknowledgement");
		const wikiOnly = JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "w1",
			toolName: "code_nav",
			args: { mode: "wiki" },
		});
		strictEqual(wikiStaleAcknowledgedFromJsonl(wikiOnly), false, "answering from the wiki alone never passes");
		const symbolThenRead = [
			JSON.stringify({ type: "tool_execution_start", toolCallId: "s1", toolName: "code_nav", args: { mode: "symbol" } }),
			JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "src/a.ts" } }),
		].join("\n");
		strictEqual(wikiStaleAcknowledgedFromJsonl(symbolThenRead), false, "only mode=wiki lookups arm the checkpoint");
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
