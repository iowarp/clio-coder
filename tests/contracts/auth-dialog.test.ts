import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { openAuthDialog } from "../../src/interactive/overlays/auth-dialog.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

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
			if (!mounted) throw new Error("auth dialog overlay was not mounted");
			return mounted;
		},
	};
}

describe("contracts/auth-dialog overlay", () => {
	it("renders status rows through dialog tokens and adapts the prompt cursor", async () => {
		const mounted = renderableTui();
		const dialog = openAuthDialog(mounted.tui, "Connect local", () => {});
		dialog.controller.setLines([
			"Target: local",
			"Runtime: openai",
			"Checking target...",
			"Target ready (healthy)",
			"Open https://example.test/device and paste the code below.",
			"* 1. Browser login (oauth)",
			"  2. API key (api-key)",
		]);

		let lines = mounted.component().render(70);
		let body = stripAnsi(lines.join("\n"));
		const targetLine = lines.find((line) => stripAnsi(line).includes("Target")) ?? "";
		const readyLine = lines.find((line) => stripAnsi(line).includes("Target ready")) ?? "";
		const choiceLine = lines.find((line) => stripAnsi(line).includes("Browser login")) ?? "";

		ok(body.includes("Checking target…"), body);
		ok(body.includes("Open https://example.test/device"), body);
		ok(!body.includes("Checking target..."), "progress text should use an ellipsis glyph");
		ok(targetLine.includes(clioTheme().fgSequence("dim")), "key labels use the dim token");
		ok(targetLine.includes(clioTheme().fgSequence("muted")), "key values use the muted token");
		ok(readyLine.includes(clioTheme().fgSequence("success")), "ready status uses the success token");
		ok(stripAnsi(readyLine).includes(GLYPH.ok), "ready status uses the shared ok glyph");
		ok(stripAnsi(choiceLine).includes(GLYPH.cursor), "default choice marker uses the design cursor");
		for (const line of lines) strictEqual(visibleWidth(line) <= 70, true, `line overflows: ${stripAnsi(line)}`);

		const answer = dialog.controller.prompt("Verification code");
		lines = mounted.component().render(70);
		body = stripAnsi(lines.join("\n"));
		const promptLine = lines.find((line) => stripAnsi(line).trimStart().startsWith(GLYPH.cursor)) ?? "";
		const labelLine = lines.find((line) => stripAnsi(line).includes("Verification code")) ?? "";

		ok(body.includes(GLYPH.cursor), body);
		ok(!stripAnsi(promptLine).trimStart().startsWith(">"), "input prompt no longer exposes the engine prompt glyph");
		ok(labelLine.includes(clioTheme().fgSequence("dim")), "prompt labels use the dim token");

		mounted.component().handleInput?.("abc123");
		mounted.component().handleInput?.("\n");
		strictEqual(await answer, "abc123");
	});
});
