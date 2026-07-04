import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { openAuthSelectorOverlay } from "../../src/interactive/overlays/auth-selector.js";
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
			if (!mounted) throw new Error("auth selector overlay was not mounted");
			return mounted;
		},
	};
}

describe("contracts/auth-selector overlay", () => {
	it("renders auth choices with the design cursor, muted previews, and ellipsis truncation", () => {
		const mounted = renderableTui();
		let selected = "";
		openAuthSelectorOverlay(mounted.tui, {
			items: [
				{
					value: "oauth",
					label: "OAuth browser authorization",
					description: "Open the browser for the selected target and wait for callback.",
				},
				{
					value: "api-key",
					label: "API key",
					description: "Paste a provider API key into the connection dialog.",
				},
			],
			onSelect: (value) => {
				selected = value;
			},
			onClose() {},
		});

		const lines = mounted.component().render(60);
		const body = stripAnsi(lines.join("\n"));
		const selectedLine = lines.find((line) => stripAnsi(line).includes("OAuth browser authorization")) ?? "";
		const apiKeyLine = lines.find((line) => stripAnsi(line).includes("API key")) ?? "";

		ok(body.includes(GLYPH.cursor), body);
		ok(!body.includes(String.fromCharCode(0x2192)), "the legacy selected-row arrow must not render");
		ok(
			stripAnsi(selectedLine).includes("…"),
			`selected row should truncate with an ellipsis: ${stripAnsi(selectedLine)}`,
		);
		ok(selectedLine.includes(boldAccentPrefix()), "selected row uses the bold accent token");
		ok(apiKeyLine.includes(clioTheme().fgSequence("muted")), "unselected descriptions use the muted token");
		for (const line of lines) strictEqual(visibleWidth(line) <= 60, true, `line overflows: ${stripAnsi(line)}`);

		mounted.component().handleInput?.("\n");
		strictEqual(selected, "oauth");
	});
});
