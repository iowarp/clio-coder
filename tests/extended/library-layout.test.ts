import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "../../src/engine/tui.js";
import { ClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";

it("fills the live terminal and reflows the Library between wide and narrow viewports", () => {
	const items = Array.from({ length: 50 }, (_, index) => ({
		id: `recipe-${index}`,
		label: `Recipe ${index}`,
		detail: () => ["# Recipe", "Source: Bundled with Clio-Coder", "Example instructions ".repeat(20)],
	}));
	const view = new ListOverlayView(
		{ title: "Library", items, fullScreen: true, filterable: true, layout: "split", onClose() {} },
		() => {},
	);
	const frame = new ClioOverlayFrame(view, "Library");
	for (const [width, rows] of [
		[140, 42],
		[48, 18],
		[100, 28],
		[32, 10],
	] as const) {
		view.setViewportRows(rows);
		frame.setRowBudget(rows);
		const rendered = frame.render(width);
		strictEqual(rendered.length, rows, `${width}x${rows} must fill the available height`);
		for (const line of rendered) strictEqual(visibleWidth(line), width);
		strictEqual(frame.render(width), rendered, "unchanged viewport keeps the frame cache");
	}
});

it("keeps ordinary list overlays compact when the terminal grows", () => {
	const view = new ListOverlayView(
		{ title: "Other list", items: [{ id: "one", label: "One" }], onClose() {} },
		() => {},
	);
	const before = view.render(90);
	view.setViewportRows(60);
	strictEqual(view.render(90), before);
});

it("keeps mode and scope controls available on an empty Library tab and visible on resize", () => {
	let mode = "Browse";
	let scope = "User";
	const view = new ListOverlayView(
		{
			title: "Library",
			items: [],
			fullScreen: true,
			filterable: true,
			explicitSearch: true,
			tabs: ["Skills", "Agents", "Prompts", "Fleets", "Plugins"].map((label) => ({
				id: label.toLowerCase(),
				label,
				items: () => [],
			})),
			activeTabId: "plugins",
			status: () => `${mode} · ${scope}`,
			globalActions: {
				b: () => {
					mode = mode === "Browse" ? "Installed" : "Browse";
				},
				s: () => {
					scope = scope === "User" ? "Project" : "User";
				},
			},
			globalHints: [
				{ key: "b", verb: "view", critical: true },
				{ key: "s", verb: "scope", critical: true },
			],
			onClose() {},
		},
		() => {},
	);
	view.setViewportRows(18);
	const first = view.render(32);
	match(stripVTControlCharacters(first.join("\n")), /Plugins 0/);
	match(stripVTControlCharacters(first.join("\n")), /Browse · User/);
	match(stripVTControlCharacters(view.getHint()), /b.*view.*s.*scope/);
	view.handleInput("b");
	view.handleInput("s");
	const next = view.render(32);
	strictEqual(next === first, false, "status changes invalidate the rendered view");
	match(stripVTControlCharacters(next.join("\n")), /Installed · Project/);
	const frame = new ClioOverlayFrame(view, "Library");
	for (const [width, rows] of [
		[32, 10],
		[140, 42],
		[48, 18],
	] as const) {
		view.setViewportRows(rows);
		frame.setRowBudget(rows);
		const lines = frame.render(width);
		strictEqual(lines.length, rows);
		for (const line of lines) strictEqual(visibleWidth(line), width);
		match(stripVTControlCharacters(lines.join("\n")), /Installed · Project/);
	}
});

it("gives an explicit search its cursor and letters, then returns to list actions without selecting", () => {
	const selected: string[] = [];
	let refreshed = 0;
	let closed = 0;
	let renders = 0;
	const items = [
		{ id: "rax", label: "rax" },
		{ id: "rxa", label: "rxa" },
	];
	const view = new ListOverlayView(
		{
			title: "Library",
			items,
			filterable: true,
			explicitSearch: true,
			tabs: [
				{ id: "one", label: "One", items: () => items },
				{ id: "two", label: "Two", items: () => items },
			],
			globalActions: {
				r: () => {
					refreshed++;
				},
			},
			onSelect: (item) => selected.push(item.id),
			onClose: () => {
				closed++;
			},
		},
		() => {
			renders++;
		},
	);
	view.render(80);
	view.handleInput("/");
	view.handleInput("r");
	view.handleInput("a");
	const beforeCursor = renders;
	view.handleInput("\u001b[D");
	strictEqual(renders > beforeCursor, true, "cursor movement requests a render even without changing the query");
	view.handleInput("x");
	strictEqual(view.activeTab()?.id, "one", "search arrows must not change category");
	strictEqual(refreshed, 0, "search letters must not invoke management");
	view.handleInput("\r");
	deepStrictEqual(selected, [], "Enter leaves search without invoking a row");
	view.handleInput("\r");
	deepStrictEqual(selected, ["rxa"]);
	view.handleInput("r");
	strictEqual(refreshed, 1);
	view.handleInput("\u001b[C");
	strictEqual(view.activeTab()?.id, "two");
	view.handleInput("/");
	view.handleInput("\u001b");
	strictEqual(closed, 0, "first Escape clears the search");
	view.handleInput("\u001b");
	strictEqual(closed, 0, "second Escape returns to the list");
	view.handleInput("\u001b");
	strictEqual(closed, 1);
});
