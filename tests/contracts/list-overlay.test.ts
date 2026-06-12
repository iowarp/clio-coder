import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type ListOverlayItem, ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";

describe("contracts/list-overlay", () => {
	it("renders grouping headers and items correctly", () => {
		const items: ListOverlayItem[] = [
			{ id: "1", label: "Apple", group: "Fruit" },
			{ id: "2", label: "Banana", group: "Fruit" },
			{ id: "3", label: "Carrot", group: "Veggie" },
		];

		let _renderCalled = false;
		const view = new ListOverlayView(
			{
				title: "Test",
				mode: "browse",
				items,
				filterable: false,
				onClose: () => {},
			},
			() => {
				_renderCalled = true;
			},
		);

		const lines = view.render(80);
		// Should contain grouping headers
		ok(lines.some((l) => l.includes("── Fruit")));
		ok(lines.some((l) => l.includes("── Veggie")));
		// Should contain items
		ok(lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));
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
				mode: "browse",
				items,
				filterable: true,
				onClose: () => {},
			},
			() => {
				_renderCount++;
			},
		);

		// Initially all are shown
		let lines = view.render(80);
		ok(lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));

		// Input 'c' to narrow to Carrot/Veggie
		view.handleInput("c");
		lines = view.render(80);
		ok(!lines.some((l) => l.includes("Apple")));
		ok(!lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));

		// Esc clears the filter first
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
				mode: "browse",
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

		// First Esc clears the filter instead of closing.
		view.handleInput("\u001b");
		strictEqual(closeCount, 0);
		lines = view.render(80);
		ok(lines.some((l) => l.includes("Apple")));
		ok(lines.some((l) => l.includes("Banana")));
		ok(lines.some((l) => l.includes("Carrot")));

		// Second Esc closes.
		view.handleInput("\u001b");
		strictEqual(closeCount, 1);
	});

	it("closes immediately on Esc when the filter is already empty", () => {
		const items: ListOverlayItem[] = [{ id: "1", label: "Apple" }];

		let closeCount = 0;
		const view = new ListOverlayView(
			{
				title: "Test",
				mode: "browse",
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
				mode: "browse",
				items,
				filterable: false,
				onClose: () => {},
			},
			() => {},
		);

		// Initial selection at 0
		let lines = view.render(80);
		ok(lines.some((l) => l.includes("→") && l.includes("Apple")));

		// j moves to 1
		view.handleInput("j");
		lines = view.render(80);
		ok(lines.some((l) => l.includes("→") && l.includes("Banana")));

		// j again wraps to 0
		view.handleInput("j");
		lines = view.render(80);
		ok(lines.some((l) => l.includes("→") && l.includes("Apple")));

		// k wraps to 1
		view.handleInput("k");
		lines = view.render(80);
		ok(lines.some((l) => l.includes("→") && l.includes("Banana")));
	});

	it("toggles detail pane and updates lines", () => {
		const items: ListOverlayItem[] = [{ id: "1", label: "Apple", detail: () => ["This is a delicious apple."] }];

		const view = new ListOverlayView(
			{
				title: "Test",
				mode: "browse",
				items,
				filterable: false,
				onClose: () => {},
			},
			() => {},
		);

		// Detail is closed initially
		let lines = view.render(80);
		ok(!lines.some((l) => l.includes("delicious")));

		// Press Tab to open detail
		view.handleInput("\t");
		lines = view.render(80);
		ok(lines.some((l) => l.includes("delicious")));

		// Press Tab again to close detail
		view.handleInput("\t");
		lines = view.render(80);
		ok(!lines.some((l) => l.includes("delicious")));
	});

	it("builds hints matching buildHint standards", () => {
		const items: ListOverlayItem[] = [{ id: "1", label: "Apple", detail: () => ["apple"] }];

		const view = new ListOverlayView(
			{
				title: "Test",
				mode: "browse",
				items,
				filterable: true,
				onClose: () => {},
			},
			() => {},
		);

		const hint = view.getHint();
		strictEqual(hint, "[↑↓] select · [type] filter · [Enter/Tab] detail · [PgUp/PgDn] scroll detail · [Esc] close");
	});
});
