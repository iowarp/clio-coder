import { deepStrictEqual, doesNotMatch, match, notDeepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import { SideQuestionOverlayBody } from "../../src/interactive/overlays/side-question.js";
import { ANIMATION_STEP_MS, GLYPH, SPINNER_FRAMES } from "../../src/interactive/theme/index.js";

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

test("the side-question spinner steps on the shared clock, not on every render", () => {
	let now = 0;
	const body = new SideQuestionOverlayBody("why is the sky blue", () => now);
	for (const width of [60, 80, 120, 200]) {
		const first = body.render(width);
		// Two frames inside one animation step draw the same spinner.
		deepStrictEqual(body.render(width), first);
		for (const row of first) ok(visibleWidth(row) <= width);
		const text = first.map(stripTerminalSequences).join("\n");
		ok(!text.includes(GLYPH.running), "the running glyph is not a spinner frame");
		ok(SPINNER_FRAMES.some((frame) => text.includes(frame)));
		now += ANIMATION_STEP_MS;
		notDeepStrictEqual(body.render(width), first);
	}
});
