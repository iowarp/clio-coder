import { deepStrictEqual, doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { sumFacts } from "../../src/core/telemetry/pricing.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { emptyTaskMemorySpendSummary } from "../../src/domains/memory/task-memory-spend.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { MemoryOverlayView } from "../../src/interactive/memory-overlay.js";
import { ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import { SideQuestionOverlayBody } from "../../src/interactive/overlays/side-question.js";
import { ACTIVITY_STEP_MS, activityCue, GLYPH } from "../../src/interactive/theme/index.js";

/**
 * A list row without metadata was padded to the full width and then given one
 * more separating space, so the row fitting exactly was cut and closed with a
 * false ellipsis. Help showed `…` on every row at 120 and 200 columns.
 */
test("a list row that fits closes without an ellipsis and a row that does not closes with one", () => {
	for (const width of [60, 80, 120, 200]) {
		const view = new ListOverlayView(
			{
				title: "Help Center",
				items: [
					{ id: "short", label: "/delegate Run an ACP delegation agent" },
					{ id: "long", label: `/run ${"[--flag <value>] ".repeat(20)}Start a run` },
					{ id: "meta", label: "/council Ask a roster", meta: "fleet" },
				],
				onClose() {},
			},
			() => {},
		);
		view.setViewportRows(30);
		const rows = view.render(width);
		for (const row of rows) ok(visibleWidth(row) <= width, `${width}: ${stripTerminalSequences(row)}`);
		const plain = rows.map(stripTerminalSequences);
		const short = plain.find((row) => row.includes("/delegate")) ?? "";
		doesNotMatch(short, /…/u, `${width}: ${short}`);
		match(plain.find((row) => row.includes("/run")) ?? "", /…/u);
		match(plain.find((row) => row.includes("/council")) ?? "", /fleet/u);
	}
});

test("side-question progress is static while a run is live and carries the cue when none is", () => {
	let now = 0;
	// A run is live: the overlay rule owns the one animated cue, so the round's lead is the static mark.
	const beside = new SideQuestionOverlayBody(
		"why is the sky blue",
		() => now,
		() => true,
	);
	for (const width of [60, 80, 120, 200]) {
		const first = beside.render(width);
		deepStrictEqual(beside.render(width), first);
		for (const row of first) ok(visibleWidth(row) <= width);
		ok(stripTerminalSequences(first.at(-1) ?? "").startsWith(`${GLYPH.running} `), "a live run keeps the lead static");
		now += ACTIVITY_STEP_MS;
		ok(stripTerminalSequences(beside.render(width).at(-1) ?? "").startsWith(`${GLYPH.running} `));
	}
	// Nothing else is live: the round is the focused work and steps on the activity clock (or stays still without motion).
	now = 0;
	const alone = new SideQuestionOverlayBody(
		"why is the sky blue",
		() => now,
		() => false,
	);
	for (const step of [0, 1, 2]) {
		now = step * ACTIVITY_STEP_MS;
		const lead = stripTerminalSequences(alone.render(80).at(-1) ?? "");
		ok(lead.startsWith(`${activityCue(now)} `), lead);
	}
});

test("memory history warnings survive 96-column rendering and cache changes with unchanged totals", () => {
	let spend = { ...emptyTaskMemorySpendSummary(), unreadableFiles: 1 };
	const view = new MemoryOverlayView(
		() => ({
			enabled: true,
			tier: "llm",
			size: 0,
			lastDecision: null,
			bank: new TaskMemoryBank().snapshot(),
			activity: [],
			stepInFlight: false,
			spend,
		}),
		() => [],
		() => {},
		() => {},
	);
	// Retained telemetry belongs to Diagnostics; Lessons opens without the raw counters.
	for (let index = 0; index < 3; index++) view.handleInput("\u001b[C");
	view.handleInput("\u001b[B");
	const unavailable = view.render(96);
	match(unavailable.map(stripTerminalSequences).join(" "), /partial retained spend.*unreadable.*unavailable/u);
	spend = {
		...spend,
		readableFiles: 1,
		llmSteps: 312,
		totalTokens: sumFacts([
			{ kind: "measured", value: 165_499, source: "provider" },
			{ kind: "unknown", reason: "not-observed" },
			{ kind: "unknown", reason: "not-observed" },
		]),
		invalidRows: 1,
	};
	const partial = view.render(96);
	match(partial.map(stripTerminalSequences).join(" "), /partial retained spend.*unreadable/u);
	spend = {
		...spend,
		unreadableFiles: 0,
		invalidRows: 0,
		totalTokens: sumFacts([{ kind: "measured", value: 165_499, source: "provider" }]),
	};
	const recovered = view.render(96);
	doesNotMatch(recovered.map(stripTerminalSequences).join("\n"), /partial|unreadable/u);
	for (const row of [...unavailable, ...partial, ...recovered]) ok(visibleWidth(row) <= 96);
});

test("a two-column list draws its meta as one column, so the text column ends at one edge", () => {
	const text = "Describes what this command does in more words than the row can hold";
	const view = new ListOverlayView(
		{
			title: "Help Center",
			items: [
				{ id: "a", label: "a", cells: { lead: "/compact", text }, meta: "Model and context" },
				{ id: "b", label: "b", cells: { lead: "/help", text }, meta: "Clio" },
				{ id: "c", label: "c", cells: { lead: "/new", text }, meta: "Session" },
			],
			onClose() {},
		},
		() => {},
	);
	view.setViewportRows(20);
	const rows = view.render(100).map(stripTerminalSequences);
	const row = (lead: string): string => rows.find((line) => line.includes(lead)) ?? "";
	const metaColumn = (lead: string, meta: string): number => row(lead).indexOf(meta);
	const column = metaColumn("/compact", "Model and context");
	ok(column > 0, rows.join("\n"));
	deepStrictEqual(
		[metaColumn("/help", "Clio"), metaColumn("/new", "Session")],
		[column, column],
		`every meta starts in one column:\n${rows.join("\n")}`,
	);
	deepStrictEqual(
		["/help", "/new"].map((lead) => row(lead).indexOf(GLYPH.ellipsis)),
		["/compact", "/compact"].map((lead) => row(lead).indexOf(GLYPH.ellipsis)),
		"every text is cut at the same column",
	);
});

test("a list mixing rows offers the detail key only on a row that has detail", () => {
	const view = new ListOverlayView(
		{
			title: "Mixed",
			items: [
				{ id: "plain", label: "plain" },
				{ id: "full", label: "full", detail: () => ["facts"] },
			],
			onSelect() {},
			onClose() {},
		},
		() => {},
	);
	view.setViewportRows(20);
	const shown = (): string => stripTerminalSequences(`${view.render(80).join("\n")}\n${view.getHint(80)}`);
	doesNotMatch(shown(), /\[Tab\]/u);
	const before = shown();
	view.handleInput("\t");
	deepStrictEqual(shown(), before, "Tab on a row without detail changes nothing");
	view.handleInput("\x1b[B");
	match(shown(), /\[Tab\] detail/u);
	view.handleInput("\t");
	match(shown(), /facts/u);
});
