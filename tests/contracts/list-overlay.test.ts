import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, TUI } from "../../src/engine/tui.js";
import { type ListOverlayItem, ListOverlayView, openListOverlay } from "../../src/interactive/overlays/list-overlay.js";
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

		// Nothing has drawn a detail pane yet, so the keys that scroll one are not
		// offered; the key that opens it is.
		view.render(80);
		strictEqual(view.getHint(), "[↑↓] select · [type] filter · [Enter/Tab] detail · [Esc] close");

		// Tab draws the pane. The scroll keys join ahead of the key that toggles it,
		// because a narrowing footer sheds droppable entries left to right.
		view.handleInput("\t");
		view.render(80);
		strictEqual(
			view.getHint(),
			"[↑↓] select · [type] filter · [PgUp/PgDn] scroll detail · [Enter/Tab] detail · [Esc] close",
		);
	});

	/**
	 * At 73 columns the memory overlay's footer read
	 * `[type] filter · [PgUp/PgDn] scroll detail · [Esc] close`. The split pane is
	 * gated on 90 columns, so PgDn moved nothing, and the narrowing pass had eaten
	 * `[Enter/Tab] detail`, which is the only way to get a pane on screen at all.
	 */
	it("advertises the key that opens the detail pane, not the dead scroll keys, at 73 columns", () => {
		const items: ListOverlayItem[] = [{ id: "1", label: "Apple", detail: () => ["a delicious apple"] }];

		let mounted: Component | null = null;
		const tui = {
			showOverlay(component: Component): OverlayHandle {
				mounted = component;
				return {
					hide: () => undefined,
					setHidden: () => undefined,
					isHidden: () => false,
					focus: () => undefined,
					unfocus: () => undefined,
					isFocused: () => true,
				};
			},
			requestRender: () => undefined,
		} as unknown as TUI;

		openListOverlay(tui, { title: "Memory", items, filterable: true, layout: "split", onClose: () => {} });
		if (mounted === null) throw new Error("the list overlay was not mounted");
		const frame = mounted as Component;
		const footer = (): string => stripAnsi(frame.render(73).at(-1) ?? "");

		// A 73-column box renders below the split threshold, so there is no pane and
		// nothing to scroll.
		const hidden = footer();
		ok(hidden.includes("[Enter/Tab] detail"), hidden);
		ok(!hidden.includes("scroll detail"), hidden);

		// Tab stacks the pane under the list. Both keys work now and both are
		// offered, but the footer has 71 columns for a 90-column hint, and what it
		// keeps is the key that toggles the pane rather than the one that scrolls it.
		frame.handleInput?.("\t");
		const shown = footer();
		ok(shown.includes("[Enter/Tab] detail"), shown);
		ok(!shown.includes("scroll detail"), shown);

		// The same state before fitting, which is where the ordering that produced
		// that outcome lives.
		const view = new ListOverlayView({ title: "Memory", items, filterable: true, onClose: () => {} }, () => {});
		view.handleInput("\t");
		view.render(69);
		const full = view.getHint();
		ok(
			full.indexOf("[PgUp/PgDn] scroll detail") < full.indexOf("[Enter/Tab] detail"),
			`the key that opens the pane must outlive the keys that scroll it: ${full}`,
		);
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

	// A filter that excluded every row and a list that never had one read the
	// same to the eye and mean different things. The caller's empty message
	// describes the second state only, and it wraps so a remedy stays legible in
	// a narrow pane instead of being cut with an ellipsis.
	it("shows the caller's empty message only for an empty list, wrapped to the pane", () => {
		const emptyMessage =
			"no skills installed and no local marketplace configured. install one with `clio-coder skills install <path>`.";
		const empty = new ListOverlayView(
			{ title: "Test", items: [], filterable: true, emptyMessage, onClose: () => {} },
			() => {},
		);
		// The first row is the filter input; the rest is the empty state.
		const rendered = empty.render(40).slice(1).map(stripAnsi);
		const body = rendered
			.filter((line) => line.trim().length > 0)
			.map((line) => line.trim())
			.join(" ");
		strictEqual(body, emptyMessage);
		ok(
			rendered.every((line) => !line.includes("…")),
			`the empty message must wrap, not truncate: ${JSON.stringify(rendered)}`,
		);

		const filtered = new ListOverlayView(
			{ title: "Test", items: [{ id: "1", label: "Apple" }], filterable: true, emptyMessage, onClose: () => {} },
			() => {},
		);
		filtered.handleInput("z");
		const filteredLines = filtered.render(80).map(stripAnsi);
		ok(
			filteredLines.some((line) => line.includes("No matches found")),
			"a filter that matched nothing says so",
		);
		ok(
			filteredLines.every((line) => !line.includes("no skills installed")),
			"a filter that matched nothing must not claim the list is empty",
		);
	});

	/**
	 * The footer advertises an overlay's action keys from the moment it opens, and
	 * the filter input holds focus then, so every first press of one landed in the
	 * filter box: `/interop` opened saying `[d] decline` and the d typed a d.
	 */
	it("runs a bound action key while the filter is focused and its query is empty", () => {
		const acted: string[] = [];
		const view = new ListOverlayView(
			{
				title: "Test",
				items: [
					{ id: "1", label: "Apple" },
					{ id: "2", label: "Banana" },
				],
				filterable: true,
				actions: { d: (item) => acted.push(item.id) },
				onClose: () => {},
			},
			() => {},
		);

		view.handleInput("d");

		deepStrictEqual(acted, ["1"], "the key acts on the selected row");
		const lines = view.render(80).map(stripAnsi);
		ok(
			lines.some((line) => line.includes("Apple")) && lines.some((line) => line.includes("Banana")),
			`and never reaches the query, which would have matched nothing: ${lines.join(" | ")}`,
		);
	});

	/**
	 * The other half of the same rule. A typed query owns the letters, because
	 * otherwise a name beginning with an action key could not be typed at all;
	 * ↑/↓ hands focus back to the list, where the key acts again.
	 */
	it("gives an action key to a nonempty query, and back to the list on an arrow", () => {
		const acted: string[] = [];
		const options = {
			title: "Test",
			items: [
				{ id: "1", label: "Apple" },
				{ id: "2", label: "Banana" },
			],
			filterable: true,
			actions: { d: (item: ListOverlayItem) => acted.push(item.id) },
			onClose: () => {},
		};

		const typing = new ListOverlayView(options, () => {});
		typing.handleInput("b");
		typing.handleInput("d");
		strictEqual(acted.length, 0, "a query in progress keeps its own letters");
		ok(
			typing
				.render(80)
				.map(stripAnsi)
				.some((line) => line.includes("No matches found")),
			"the d joined the query",
		);

		const onList = new ListOverlayView(options, () => {});
		onList.handleInput("b");
		onList.handleInput("[B");
		onList.handleInput("d");
		deepStrictEqual(acted, ["2"], "the key acts again once the list has focus");
	});

	it("repaints replaced rows through the handle rather than the array the caller passed", () => {
		let mounted: Component | null = null;
		let renders = 0;
		const tui = {
			showOverlay(component: Component): OverlayHandle {
				mounted = component;
				return {
					hide: () => undefined,
					setHidden: () => undefined,
					isHidden: () => false,
					focus: () => undefined,
					unfocus: () => undefined,
					isFocused: () => true,
				};
			},
			requestRender: () => {
				renders += 1;
			},
		} as unknown as TUI;

		const handle = openListOverlay(tui, {
			title: "Test",
			items: [{ id: "1", label: "Apple" }],
			filterable: true,
			onClose: () => {},
		});
		if (mounted === null) throw new Error("the list overlay was not mounted");
		const frame = mounted as Component;
		ok(frame.render(80).some((line) => line.includes("Apple")));

		handle.setItems([{ id: "2", label: "Banana" }]);

		strictEqual(renders, 1, "replacing the rows asks for the repaint");
		const lines = frame.render(80).map(stripAnsi);
		ok(
			lines.some((line) => line.includes("Banana")),
			`the frame is drawn from the new rows: ${lines.join(" | ")}`,
		);
		ok(!lines.some((line) => line.includes("Apple")), lines.join(" | "));
	});

	it("offers only Esc in the footer when the list has no rows", () => {
		const view = new ListOverlayView(
			{
				title: "Test",
				items: [],
				filterable: true,
				emptyMessage: "nothing here yet",
				hints: [{ key: "i", verb: "install" }],
				onSelect: () => {},
				onClose: () => {},
			},
			() => {},
		);
		strictEqual(view.getHint(), "[Esc] close");
	});
});
