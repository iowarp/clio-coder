import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { ListOverlayView, NARROW_ROW_WIDTH } from "../../src/interactive/overlays/list-overlay.js";
import { compactArgumentHint } from "../../src/interactive/slash-autocomplete.js";

/**
 * Below 80 columns the help list drops a command's flags before it cuts the
 * description, sharing the composer popup's rule rather than copying it. At
 * 60 and 80 columns `/run [--agent-profile <profile>] [--runtime …` used to
 * leave nothing of what /run does.
 */
test("a list row draws its narrow label at and below the narrow row width and the full label above it", () => {
	const description = "Start a run in the current workspace";
	const view = new ListOverlayView(
		{
			title: "Help Center",
			items: [
				{
					id: "run",
					label: `/run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] <task> ${description}`,
					narrowLabel: `/run <task>${" ".repeat(19)}${description}`,
				},
			],
			onClose() {},
		},
		() => {},
	);
	view.setViewportRows(30);
	for (const width of [60, 80, 120, 200]) {
		const rows = view.render(width);
		for (const row of rows) ok(visibleWidth(row) <= width, `${width}: ${stripTerminalSequences(row)}`);
		const row = rows.map(stripTerminalSequences).find((line) => line.includes("/run")) ?? "";
		if (width <= NARROW_ROW_WIDTH) {
			doesNotMatch(row, /--agent-profile/u, `${width}: flags dropped first`);
			match(row, /Start a run/u, `${width}: the description survives`);
		} else {
			match(row, /--agent-profile/u, `${width}: full usage`);
		}
	}
	strictEqual(NARROW_ROW_WIDTH, 76, "the content width of an 80-column terminal");
});

test("the shared argument rule keeps positionals when a caller hands it a spec without flags", () => {
	strictEqual(compactArgumentHint({ positionals: [{ name: "task", required: true }] }), "<task>");
	strictEqual(compactArgumentHint(undefined), undefined);
});
