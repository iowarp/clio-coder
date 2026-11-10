import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { composeReportDraft, planReport, type ReportFlowOutcome } from "../../src/domains/report/index.js";
import { createReportReview } from "../../src/interactive/overlays/report-review.js";

test("report review: Enter never sends, and s on the send step calls the sender once", async () => {
	const draft = composeReportDraft({
		kind: "bug",
		surface: "tui",
		title: "fix: footer flickers while a turn streams",
		happened: "The footer flickered on every keystroke while a long turn streamed tool output.",
	});
	const identity = { packageRoot: null, paths: [], remotes: [], names: [] };
	let sends = 0;
	const review = createReportReview({
		draft,
		plan: (current) => planReport(current, { identity, transport: { kind: "file" } }),
		edit: () => null,
		send: async (current) => {
			sends += 1;
			return { kind: "stopped", draft: current, verdict: { kind: "none" } } as unknown as ReportFlowOutcome;
		},
		onCancel: () => {},
		onDone: () => {},
		requestRender: () => {},
	});

	for (let i = 0; i < 10; i += 1) review.handleInput("\r");
	strictEqual(review.step(), "send");
	strictEqual(sends, 0);

	review.handleInput("s");
	review.handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(sends, 1);
});
