import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchCountFromJsonl, scoutDispatchCountFromJsonl } from "../../src/domains/eval/metrics/evidence.js";
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

	it("retains compact dispatch evidence across chunk splits and stdout truncation", () => {
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
				type: "clio_tool_finish",
				payload: { tool: "dispatch", toolCallId: "dispatch-1", outcome: "ok", result: "y".repeat(100_000) },
			})}\n`,
		);
		const metricJsonl = capture.finish();
		strictEqual(scoutDispatchCountFromJsonl(metricJsonl), 1);
		strictEqual(dispatchCountFromJsonl(metricJsonl), 1);
		ok(metricJsonl.length < 2_000, "large tool results are not retained in metric evidence");
	});

	it("preserves the bounded SIGINT chaos marker exactly", () => {
		const marker = {
			type: "clio_soak_chaos",
			seed: 90210,
			faultInjected: true,
			exitCode: 130,
			orphanedChildren: 0,
		};
		const encoded = JSON.stringify(marker);
		const capture = createJsonlMetricCapture();
		capture.push(encoded.slice(0, 23));
		capture.push(encoded.slice(23));
		strictEqual(capture.finish(), encoded);
	});
});
