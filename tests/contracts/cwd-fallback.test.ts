import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { buildCwdFallbackItems, openCwdFallbackOverlay } from "../../src/interactive/overlays/cwd-fallback.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const boldAccentPrefix = (): string => clioTheme().style("accent", "", { bold: true }).replace(`${ESC}[0m`, "");

function renderableTui(): { tui: TUI; component: () => Component } {
	let mounted: Component | null = null;
	const handle: OverlayHandle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	const tui = {
		showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
			mounted = component;
			return handle;
		},
		requestRender() {},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("cwd fallback overlay was not mounted");
			return mounted;
		},
	};
}

describe("contracts/cwd-fallback overlay", () => {
	it("keeps the two recovery choices and styles the rendered selector", () => {
		const items = buildCwdFallbackItems({
			currentCwd: "/repo/current",
			sessionCwd: "/old/project",
			reason: "missing",
		});
		strictEqual(items.length, 2);
		strictEqual(items[0]?.value, "continue");
		strictEqual(items[1]?.value, "cancel");

		const mounted = renderableTui();
		const calls: string[] = [];
		openCwdFallbackOverlay(mounted.tui, {
			currentCwd: "/repo/current",
			sessionCwd: "/old/project",
			reason: "missing",
			onContinue: () => calls.push("continue"),
			onCancel: () => calls.push("cancel"),
			onClose: () => calls.push("close"),
		});

		const lines = mounted.component().render(60);
		const body = stripAnsi(lines.join("\n"));
		const selectedLine = lines.find((line) => stripAnsi(line).includes("Continue in")) ?? "";
		const cancelLine = lines.find((line) => stripAnsi(line).includes("Cancel")) ?? "";

		ok(body.includes(GLYPH.cursor), body);
		ok(!body.includes(String.fromCharCode(0x2192)), "the legacy selected-row arrow must not render");
		const collapsed = stripAnsi(lines.join(" ")).replace(/[│\s]+/gu, " ");
		ok(
			collapsed.includes("session cwd /old/project is missing; use this terminal's cwd instead"),
			`selected recovery explanation must wrap in full: ${collapsed}`,
		);
		ok(!stripAnsi(selectedLine).includes("…"), `selected row is no longer a cut explanation: ${stripAnsi(selectedLine)}`);
		ok(selectedLine.includes(boldAccentPrefix()), "selected row uses the bold accent token");
		ok(cancelLine.includes(clioTheme().fgSequence("muted")), "unselected descriptions use the muted token");
		for (const line of lines) strictEqual(visibleWidth(line) <= 60, true, `line overflows: ${stripAnsi(line)}`);

		mounted.component().handleInput?.("\n");
		deepStrictEqual(calls, ["continue", "close"]);
	});
});
