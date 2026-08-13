import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { openExtensionsOverlay } from "../../src/interactive/overlays/extensions.js";
import type { ListOverlayOptions } from "../../src/interactive/overlays/list-overlay.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

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

describe("contracts/extensions-overlay", () => {
	it("uses semantic metadata tokens for active, disabled, and shadowed extensions", () => {
		const mounted = captureListOptions();
		openExtensionsOverlay(
			mounted.tui,
			{
				listExtensions: () => [
					{
						id: "github",
						scope: "user",
						description: "GitHub workflow helpers",
						version: "1.0.0",
						enabled: true,
						effective: true,
					},
					{
						id: "old",
						scope: "project",
						description: "Shadowed extension",
						version: "0.1.0",
						enabled: true,
						effective: false,
						overriddenBy: "user",
					},
					{
						id: "disabled",
						scope: "project",
						description: "Disabled extension",
						version: "0.1.0",
						enabled: false,
						effective: false,
					},
				],
			} as never,
			() => {},
		);

		const options = mounted.options();
		strictEqual(options.title, "Extensions Reference");
		// Browse-only: Enter toggles the detail pane rather than committing.
		strictEqual(options.onSelect, undefined);
		strictEqual(
			options.items.every((item) => item.group === "Extensions"),
			true,
		);
		ok(options.items.find((item) => item.id === "github")?.meta?.includes(clioTheme().fgSequence("success")));
		ok(options.items.find((item) => item.id === "old")?.meta?.includes(clioTheme().fgSequence("warning")));
		ok(options.items.find((item) => item.id === "disabled")?.meta?.includes(clioTheme().fgSequence("dim")));
	});
});
