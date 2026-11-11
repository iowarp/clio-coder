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

test("report review: the attach step ticks a bundle, rebuilds it per tick, pages it with v, and sends that bundle", async () => {
	const draft = composeReportDraft({
		kind: "bug",
		surface: "tui",
		title: "fix: footer flickers while a turn streams",
		happened: "The footer flickered on every keystroke while a long turn streamed tool output.",
	});
	const identity = { packageRoot: null, paths: [], remotes: [], names: [] };
	const asked: Array<{ attach: boolean; dataset: boolean; transcript: boolean; anonymizeModels: boolean }> = [];
	let sentBundle: string | null | undefined;
	const review = createReportReview({
		draft,
		plan: (current) => planReport(current, { identity, transport: { kind: "file" } }),
		edit: () => null,
		bundle: async (choice) => {
			asked.push(choice);
			const sha256 = `sha-${asked.length}`;
			return { sha256, summary: [`Diagnostic bundle ${sha256}`], pages: ["==> report.json <==", `{"n":${asked.length}}`] };
		},
		send: async (current, _plan, _choose, choices) => {
			sentBundle = choices.bundle?.sha256 ?? null;
			return { kind: "stopped", draft: current, verdict: { kind: "none" } } as unknown as ReportFlowOutcome;
		},
		onCancel: () => {},
		onDone: () => {},
		requestRender: () => {},
	});
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	review.handleInput("\r");
	strictEqual(review.step(), "attach");
	strictEqual(review.render(80, 0).join("\n").includes("[ ] b"), true, "the bundle is offered, never pre-ticked");
	review.handleInput("t");
	strictEqual(asked.length, 0, "a refining tick does nothing until the bundle is ticked");

	review.handleInput("b");
	review.handleInput("\r");
	strictEqual(review.step(), "attach", "Enter waits for the ticked bundle to be built");
	await settle();
	review.handleInput("t");
	await settle();
	strictEqual(asked.length, 2);
	strictEqual(asked[1]?.transcript, true);
	strictEqual(asked[1]?.dataset, false);
	strictEqual(review.render(80, 0).join("\n").includes("Diagnostic bundle sha-2"), true);

	review.handleInput("v");
	strictEqual(review.step(), "bundle");
	strictEqual(review.render(80, 0).join("\n").includes('{"n":2}'), true);
	review.handleInput("\u001b");
	strictEqual(review.step(), "attach");

	review.handleInput("\r");
	review.handleInput("s");
	await settle();
	strictEqual(sentBundle, "sha-2");
});
