import { deepStrictEqual, doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { emptyTaskMemorySpendSummary } from "../../src/domains/memory/task-memory-spend.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { MemoryOverlayView } from "../../src/interactive/memory-overlay.js";
import { ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import { SideQuestionOverlayBody } from "../../src/interactive/overlays/side-question.js";
import { ANIMATION_STEP_MS, GLYPH } from "../../src/interactive/theme/index.js";

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

test("routine side-question progress remains static across renders and clock steps", () => {
	let now = 0;
	const body = new SideQuestionOverlayBody("why is the sky blue", () => now);
	for (const width of [60, 80, 120, 200]) {
		const first = body.render(width);
		// Two frames inside one animation step draw the same spinner.
		deepStrictEqual(body.render(width), first);
		for (const row of first) ok(visibleWidth(row) <= width);
		const text = first.map(stripTerminalSequences).join("\n");
		ok(text.includes(GLYPH.running), "routine progress uses the static running mark");
		now += ANIMATION_STEP_MS;
		deepStrictEqual(body.render(width), first);
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
	const unavailable = view.render(96);
	match(unavailable.map(stripTerminalSequences).join("\n"), /partial retained spend.*unreadable.*unavailable/u);
	spend = { ...spend, readableFiles: 1, llmSteps: 312, totalTokens: 165_499, invalidRows: 1, missingTokenCalls: 2 };
	const partial = view.render(96);
	match(partial.map(stripTerminalSequences).join("\n"), /partial retained spend.*unreadable/u);
	spend = { ...spend, unreadableFiles: 0, invalidRows: 0, missingTokenCalls: 0 };
	const recovered = view.render(96);
	doesNotMatch(recovered.map(stripTerminalSequences).join("\n"), /partial|unreadable/u);
	for (const row of [...unavailable, ...partial, ...recovered]) ok(visibleWidth(row) <= 96);
});
