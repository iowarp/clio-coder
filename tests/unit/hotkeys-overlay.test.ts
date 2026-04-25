import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { createKeybindingManagerForTesting } from "../../src/interactive/keybinding-manager.js";
import { buildHotkeyEntries, formatHotkeysLines } from "../../src/interactive/overlays/hotkeys.js";
import { formatKeybindingDetailLines } from "../../src/interactive/overlays/keybinding-detail.js";

describe("interactive/overlays/hotkeys", () => {
	it("renders selectable rows and the detail hint", () => {
		const manager = createKeybindingManagerForTesting();
		const lines = formatHotkeysLines(buildHotkeyEntries(manager), 70, { selectedIndex: 0 });
		const text = lines.join("\n");
		ok(text.includes("> Shift+Tab"), text);
		ok(text.includes("[E] details"), text);
		ok(text.includes("GLOBAL"), text);
	});

	it("surfaces platform warnings in the overlay", () => {
		const manager = createKeybindingManagerForTesting(
			{ "clio.model.cycleBackward": "shift+ctrl+p" },
			{ TERM: "xterm-256color" },
		);
		const lines = formatHotkeysLines(buildHotkeyEntries(manager), 70, { warnings: manager.platformWarnings() });
		const text = lines.join("\n");
		ok(text.includes("needs CSI-u"), text);
		ok(text.includes("clio.model.cycleBackward"), text);
	});

	it("renders a keybinding detail panel with settings guidance", () => {
		const lines = formatKeybindingDetailLines({
			id: "clio.model.select",
			keys: "Ctrl+L",
			action: "Open the model selector",
			source: "default",
		});
		const text = lines.join("\n");
		ok(text.includes("Keybinding"), text);
		ok(text.includes("settings.yaml > keybindings"), text);
		ok(text.includes('clio.model.select: "alt+<key>"'), text);
	});
});
