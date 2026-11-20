import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	composeReportDraft,
	duplicateOptions,
	planReport,
	type RelatedIssue,
	type ReportFlowOutcome,
} from "../../src/domains/report/index.js";
import type { TUI } from "../../src/engine/tui.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import { createReportReview, type openReportReviewOverlay } from "../../src/interactive/overlays/report-review.js";
import { createReportHost } from "../../src/interactive/report-flow.js";

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

test("report review: gh is asked who is signed in only after s, and Enter on a match cancels instead of commenting (TUI-16)", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-review-consent-"));
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	let detections = 0;
	let options: Parameters<typeof openReportReviewOverlay>[1] | undefined;
	const host = createReportHost({
		tui: { requestRender: () => {} } as unknown as TUI,
		transitions: { state: "closed", handle: null, close: () => {} } as unknown as OverlayTransitions,
		stateDir,
		cwd: stateDir,
		env: {},
		notify: () => {},
		findGh: () => "/usr/bin/gh",
		detect: async () => {
			detections += 1;
			return { kind: "browser" };
		},
		openReview: (_tui, opened) => {
			options = opened;
			return { review: { refresh: () => {} } } as unknown as ReturnType<typeof openReportReviewOverlay>;
		},
	});
	host.open({ kind: "bug", summary: "fix: footer flickers while a turn streams" });
	for (let i = 0; i < 20 && options === undefined; i += 1) await settle();
	ok(options?.prepare, "the review opened with a consent-time transport check");
	strictEqual(detections, 0, "opening the review asks gh nothing");
	strictEqual(options.plan(options.draft).postedAs, "posted from your gh account");
	strictEqual(await options.prepare(), false, "gh is not signed in, so the plan changed and s must be pressed again");
	strictEqual(options.plan(options.draft).postedAs, "opens your browser");
	strictEqual(await options.prepare(), true);
	strictEqual(detections, 1);

	const draft = composeReportDraft({
		kind: "bug",
		surface: "tui",
		title: "fix: footer flickers while a turn streams",
		happened: "The footer flickered on every keystroke while a long turn streamed tool output.",
	});
	const identity = { packageRoot: null, paths: [], remotes: [], names: [] };
	const issue = { number: 512, title: "footer flickers", url: "u", state: "open" } as RelatedIssue;
	let prepared = 0;
	let chosen: string | undefined;
	const review = createReportReview({
		draft,
		plan: (current) => planReport(current, { identity, transport: { kind: "file" } }),
		edit: () => null,
		prepare: async () => {
			prepared += 1;
			return prepared > 1;
		},
		send: async (current, _plan, choose) => {
			const verdict = { kind: "comment", issue } as const;
			chosen = await choose(verdict, duplicateOptions(verdict) ?? []);
			return { kind: "stopped", draft: current, verdict } as unknown as ReportFlowOutcome;
		},
		onCancel: () => {},
		onDone: () => {},
		requestRender: () => {},
	});
	review.handleInput("\r");
	review.handleInput("\r");
	strictEqual(prepared, 0);
	review.handleInput("s");
	await settle();
	strictEqual(review.step(), "send", "a changed plan returns to the send step and sends nothing");
	review.handleInput("s");
	await settle();
	await settle();
	strictEqual(review.step(), "duplicates");
	review.handleInput("\r");
	await settle();
	strictEqual(chosen, "stop");
});
