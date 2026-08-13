import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type ListOverlayItem, ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("contracts/list-overlay", () => {
	it("renders grouping headers and items correctly", () => {
		const items: ListOverlayItem[] = [
			{ id: "1", label: "Apple", group: "Fruit" },
			{ id: "2", label: "Banana", group: "Fruit" },
			{ id: "3", label: "Carrot", group: "Veggie" },
		];

		const view = new ListOverlayView(
			{
				title: "Test",
				items,
				filterable: false,
				onClose: () => {},
			},
			() => {},
		);

		const lines = view.render(80);
		// The rendered list includes both group headers.
		ok(lines.some((l) => l.includes("── Fruit")));
		ok(lines.some((l) => l.includes("── Veggie")));
		const fruitHeader = lines.find((l) => l.includes("── Fruit")) ?? "";
		ok(fruitHeader.includes(clioTheme().fgSequence("dim")), "group headers render in the dim token");
		// The rendered list includes each item in its group.
		ok(lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));
		const selected = stripAnsi(lines.find((l) => l.includes("Apple")) ?? "");
		ok(selected.includes(GLYPH.cursor), `selected row should use ${GLYPH.cursor}, got: ${selected}`);
		ok(!selected.includes(String.fromCharCode(0x2192)), "the legacy engine arrow must not render");
	});

	it("filters items fuzzy matching label and group, and clears on Esc", () => {
		const items: ListOverlayItem[] = [
			{ id: "1", label: "Apple", group: "Fruit" },
			{ id: "2", label: "Banana", group: "Fruit" },
			{ id: "3", label: "Carrot", group: "Veggie" },
		];

		let _renderCount = 0;
		const view = new ListOverlayView(
			{
				title: "Test",
				items,
				filterable: true,
				onClose: () => {},
			},
			() => {
				_renderCount++;
			},
		);

		// The initial render shows every item.
		let lines = view.render(80);
		ok(lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));

		// Typing c narrows the list to Carrot and its group.
		view.handleInput("c");
		lines = view.render(80);
		ok(!lines.some((l) => l.includes("Apple")));
		ok(!lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));

		// Esc clears the filter before it closes the overlay.
		view.handleInput("\u001b");
		lines = view.render(80);
		ok(lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));
	});

	it("clears a nonempty filter on first Esc and closes on second Esc when the list has focus", () => {
		const items: ListOverlayItem[] = [
			{ id: "1", label: "Apple", group: "Fruit" },
			{ id: "2", label: "Banana", group: "Fruit" },
			{ id: "3", label: "Carrot", group: "Veggie" },
		];

		let closeCount = 0;
		const view = new ListOverlayView(
			{
				title: "Test",
				items,
				filterable: true,
				initialFilter: "c",
				onClose: () => {
					closeCount++;
				},
			},
			() => {},
		);

		// Arrow down moves focus from the filter input to the list.
		view.handleInput("\u001b[B");
		let lines = view.render(80);
		ok(!lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Carrot")));

		// The first Esc clears the filter instead of closing.
		view.handleInput("\u001b");
		strictEqual(closeCount, 0);
		lines = view.render(80);
		ok(lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));

		// The second Esc closes the overlay.
		view.handleInput("\u001b");
		strictEqual(closeCount, 1);
	});

	it("closes immediately on Esc when the filter is already empty", () => {
		const items: ListOverlayItem[] = [{ id: "1", label: "Apple" }];

		let closeCount = 0;
		const view = new ListOverlayView(
			{
				title: "Test",
				items,
				filterable: true,
				onClose: () => {
					closeCount++;
				},
			},
			() => {},
		);

		view.handleInput("\u001b");
		strictEqual(closeCount, 1);
	});

	it("wraps selection on j/k keys when filter is not focused", () => {
		const items: ListOverlayItem[] = [
			{ id: "1", label: "Apple" },
			{ id: "2", label: "Banana" },
		];

		const view = new ListOverlayView(
			{
				title: "Test",
				items,
				filterable: false,
				onClose: () => {},
			},
			() => {},
		);

		// The initial selection starts at the first row.
		let lines = view.render(80);
		ok(lines.some((l) => l.includes(GLYPH.cursor) && l.includes("Apple")));

		// Pressing j moves the selection to the second row.
		view.handleInput("j");
		lines = view.render(80);
		ok(lines.some((l) => l.includes(GLYPH.cursor) && l.includes("Banana")));

		// Pressing j again wraps the selection to the first row.
		view.handleInput("j");
		lines = view.render(80);
		ok(lines.some((l) => l.includes(GLYPH.cursor) && l.includes("Apple")));

		// Pressing k wraps the selection to the second row.
		view.handleInput("k");
		lines = view.render(80);
		ok(lines.some((l) => l.includes(GLYPH.cursor) && l.includes("Banana")));
	});

	it("toggles detail pane and updates lines", () => {
		const items: ListOverlayItem[] = [{ id: "1", label: "Apple", detail: () => ["This is a delicious apple."] }];

		const view = new ListOverlayView(
			{
				title: "Test",
				items,
				filterable: false,
				onClose: () => {},
			},
			() => {},
		);

		// The detail pane is closed initially.
		let lines = view.render(80);
		ok(!lines.some((l) => l.includes("delicious")));

		// Pressing Tab opens the detail pane.
		view.handleInput("\t");
		lines = view.render(80);
		ok(lines.some((l) => l.includes("delicious")));
		const divider = lines.find((l) => stripAnsi(l).includes("─"));
		ok(divider?.includes(clioTheme().fgSequence("frame")), "detail divider uses the frame token");

		// Pressing Tab again closes the detail pane.
		view.handleInput("\t");
		lines = view.render(80);
		ok(!lines.some((l) => l.includes("delicious")));
	});

	it("builds hints matching buildHint standards", () => {
		const items: ListOverlayItem[] = [{ id: "1", label: "Apple", detail: () => ["apple"] }];

		const view = new ListOverlayView(
			{
				title: "Test",
				items,
				filterable: true,
				onClose: () => {},
			},
			() => {},
		);

		const hint = view.getHint();
		strictEqual(hint, "[↑↓] select · [type] filter · [Enter/Tab] detail · [PgUp/PgDn] scroll detail · [Esc] close");
	});

	it("styles an empty filtered list as muted neutral content", () => {
		const view = new ListOverlayView(
			{
				title: "Test",
				items: [{ id: "1", label: "Apple" }],
				filterable: true,
				onClose: () => {},
			},
			() => {},
		);

		view.handleInput("z");
		const emptyLine = view.render(80).find((line) => line.includes("No matches found")) ?? "";
		ok(emptyLine.includes(clioTheme().fgSequence("muted")), "empty filtered state is muted, not a warning");
	});
});
