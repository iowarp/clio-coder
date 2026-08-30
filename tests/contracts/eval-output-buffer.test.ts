import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { appendLimited, createJsonlMetricCapture } from "../../src/domains/eval/runners/external-command.js";

describe("contracts/eval output buffer", () => {
	it("preserves the terminal tail after verbose output crosses the cap", () => {
		const head = "HEAD-SENTINEL\n";
		let output = appendLimited("", `${head}${"x".repeat(210_000)}`);
		output = appendLimited(output, "\nTAIL-RECEIPT-SENTINEL");
		ok(output.startsWith(head));
		ok(output.includes("[output middle truncated; tail preserved]"));
		ok(output.endsWith("TAIL-RECEIPT-SENTINEL"));
		strictEqual(output.length, 200_000);
	});

	it("retains compact tool evidence across chunk splits and stdout truncation", () => {
		const capture = createJsonlMetricCapture();
		capture.push(`${"x".repeat(70_000)}\n`);
		const dispatchStart = JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "dispatch-1",
			toolName: "dispatch",
			args: { tasks: [{ agent: "scout", task: "map the repo" }] },
		});
		capture.push(dispatchStart.slice(0, 37));
		capture.push(`${dispatchStart.slice(37)}\n`);
		capture.push(
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "fixtures/target.ts", ignored: "must-not-survive" },
			})}\n`,
		);
		capture.push(
			`${JSON.stringify({
				type: "clio_tool_finish",
				payload: { tool: "dispatch", toolCallId: "dispatch-1", outcome: "ok", result: "y".repeat(100_000) },
			})}\n`,
		);
		const metricJsonl = capture.finish();
		ok(metricJsonl.includes('"toolName":"dispatch"'));
		ok(metricJsonl.includes('"tool":"dispatch"'));
		ok(metricJsonl.includes('"args":{"path":"fixtures/target.ts"}'));
		strictEqual(metricJsonl.includes("must-not-survive"), false);
		ok(metricJsonl.length < 2_000, "large tool results are not retained in metric evidence");
	});
});
