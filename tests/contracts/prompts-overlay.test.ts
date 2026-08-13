import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import type { ListOverlayOptions } from "../../src/interactive/overlays/list-overlay.js";
import { openPromptsOverlay } from "../../src/interactive/overlays/prompts.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function captureListOptions(): { tui: TUI; options: () => ListOverlayOptions } {
	let captured: ListOverlayOptions | null = null;
	const handle: OverlayHandle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	return {
		tui: {
			showOverlay(component: Component, _options?: OverlayOptions): OverlayHandle {
				const frame = component as unknown as { child: { options: ListOverlayOptions } };
				captured = frame.child.options;
				return handle;
			},
			requestRender() {},
		} as unknown as TUI,
		options: () => {
			if (!captured) throw new Error("list overlay options were not captured");
			return captured;
		},
	};
}

describe("contracts/prompts-overlay", () => {
	it("renders prompt templates and diagnostics through the list-overlay grammar", () => {
		const mounted = captureListOptions();
		openPromptsOverlay(
			mounted.tui,
			{
				listPrompts: () => ({
					items: [{ name: "review", argumentHint: "<scope>", description: "Review a focused change" }],
					diagnostics: [{ type: "warning", message: "fragment is stale", path: "/repo/prompts/review.md" }],
				}),
				setEditorText: () => {},
			} as never,
			() => {},
		);

		const options = mounted.options();
		strictEqual(options.title, "Prompt Templates");
		strictEqual(typeof options.onSelect, "function", "picking a template commits it");
		const template = options.items.find((item) => item.id === "review");
		ok(template);
		strictEqual(template?.group, "Prompt Templates");
		strictEqual(template?.meta, "<scope>");
		const diagnostic = options.items.find((item) => item.group === "Diagnostics");
		ok(diagnostic);
		strictEqual(stripAnsi(diagnostic?.label ?? ""), `${GLYPH.warnInline} fragment is stale`);
		ok(diagnostic?.label.includes(clioTheme().fgSequence("warning")), "warning diagnostics use the warning token");
		strictEqual(diagnostic?.meta, "/repo/prompts/review.md");
	});
});
