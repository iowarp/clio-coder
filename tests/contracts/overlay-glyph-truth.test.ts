import { doesNotMatch, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Component,
	type OverlayOptions,
	stripTerminalSequences,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import { dockTop } from "../../src/interactive/dock.js";
import { createLeaderMenu } from "../../src/interactive/leader-menu.js";
import { createAskUserViewForTesting } from "../../src/interactive/overlays/ask-user.js";
import { formatCompositeTasksOverlayBodyLines } from "../../src/interactive/tasks-overlay.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

const WIDTHS = [60, 80, 120, 200] as const;
const plain = (lines: ReadonlyArray<string>): string[] => lines.map(stripTerminalSequences);

/** Every line fits, and the only escapes are SGR colour runs. */
function assertRenderDiscipline(lines: ReadonlyArray<string>, width: number): void {
	for (const line of lines) {
		ok(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
		const stray = line
			.split("\u001b")
			.slice(1)
			.filter((run) => !/^\[[0-9;]*m/u.test(run));
		ok(stray.length === 0, "only SGR escapes leave a render function");
	}
}

function mountLeaderMenu() {
	let component: Component | undefined;
	let options: (OverlayOptions & { footerHint?: (innerWidth: number) => string | undefined }) | undefined;
	const tui = {
		terminal: { rows: 30, columns: 120 },
		requestRender: () => {},
		showOverlay: (child: Component, supplied: OverlayOptions) => {
			component = child;
			options = supplied;
			return { hide: () => {} };
		},
	} as unknown as TUI;
	const update = createLeaderMenu(
		tui,
		() => "composer",
		(id) => (id === "clio-coder.leader" ? "Ctrl+G" : "Alt+X"),
	);
	update({ status: "pending", selected: 1 }, [
		{ key: "a", id: "clio-coder.exit", label: "Exit" },
		{ key: "b", id: "clio-coder.leader", label: "Leader" },
		{ key: "", id: "clio-coder.exit", label: "Unbound action" },
	]);
	// The engine overlay is a zero-row focus proxy; the frame itself lives in the dock.
	void component;
	const frame = dockTop(tui)?.frame as unknown as Component;
	return { frame, options };
}

test("the leader menu marks focus with the cursor glyph, blanks an unbound key, and spells its hints like every footer", () => {
	const { frame } = mountLeaderMenu();
	for (const width of WIDTHS) {
		const lines = frame.render(width);
		assertRenderDiscipline(lines, width);
		const text = plain(lines);
		const focused = text.find((row) => row.includes("Leader")) ?? "";
		ok(focused.includes(`${GLYPH.cursor} b  Leader`), `${width}: ${focused}`);
		const unbound = text.find((row) => row.includes("Unbound action")) ?? "";
		doesNotMatch(unbound, /·\s+Unbound/u, `${width}: an unbound key is a blank, not the internal-run mark`);
		doesNotMatch(text.join("\n"), /›|Up\/Down|Enter run/u);
		if (width >= 80) match(text.join("\n"), /\[↑↓\] select · \[Enter\] run · \[Ctrl\+C\] cancel/u);
		match(text.join("\n"), /\[Ctrl\+G\/Esc\] close/u);
	}
});

test("the ask-user question strip uses the cursor glyph for the current question and blank for a pending one", () => {
	const view = createAskUserViewForTesting({ rows: 30 });
	view.ask([
		{ question: "First question?", options: [{ label: "A" }, { label: "B" }] },
		{ question: "Second question?", options: [{ label: "C" }, { label: "D" }] },
	]);
	for (const width of [120, 200] as const) {
		const lines = view.render(width);
		assertRenderDiscipline(lines, width);
		const text = plain(lines).join("\n");
		ok(text.includes(`${GLYPH.cursor} 1. First`), text);
		doesNotMatch(text, /○|› /u);
	}
});

test("the tasks body does not repeat the frame title as its first heading", () => {
	for (const width of WIDTHS) {
		const lines = formatCompositeTasksOverlayBodyLines({ board: null, history: [], artifacts: [], userTasks: [] }, width);
		assertRenderDiscipline(lines, width);
		const text = plain(lines);
		ok(!text.some((row) => row.trim() === "Tasks"), `${width}: ${text[0]}`);
		match(text.join("\n"), /Task history/u);
	}
});

test("overlay modules take the ellipsis from the glyph table", () => {
	const root = fileURLToPath(new URL("../../src/interactive/", import.meta.url));
	for (const file of [
		"overlays/list-overlay.ts",
		"overlays/auth-dialog.ts",
		"overlays/cwd-fallback.ts",
		"overlays/context-reset.ts",
		"overlays/keybinding-detail.ts",
		"overlays/ask-user.ts",
		"overlays/settings.ts",
		"view/view-overlay.ts",
	]) {
		doesNotMatch(readFileSync(`${root}${file}`, "utf8"), /const ELLIPSIS = "…"/u, file);
	}
});
