import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioKeybinding } from "../../src/domains/config/keybindings.js";
import type { Component, OverlayOptions, TUI } from "../../src/engine/tui.js";
import type { ClioKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { openHelpOverlay } from "../../src/interactive/overlays/help-reference.js";
import type { ListOverlayOptions } from "../../src/interactive/overlays/list-overlay.js";
import { commandReference, parseSlashCommand } from "../../src/interactive/slash-commands.js";

describe("contracts/help-reference", () => {
	it("ensures /hotkeys slash command no longer parses (returns unknown)", () => {
		const cmd = parseSlashCommand("/hotkeys");
		strictEqual(cmd.kind, "unknown");
		if (cmd.kind === "unknown") {
			strictEqual(cmd.text, "/hotkeys");
		} else {
			throw new Error("expected unknown command");
		}
	});

	it("populates Commands and Keys groups correctly in the help overlay", () => {
		const mockManager: ClioKeybindingManager = {
			matches: () => false,
			getKeys: () => [],
			getDescription: () => "",
			getConflicts: () => [],
			overrideCount: () => 0,
			invalidCount: () => 0,
			invalidBindings: () => [],
			platformWarnings: () => [],
			leaderTargets: () => [],
			hotkeyEntries: () => [
				{
					id: "clio.exit" as ClioKeybinding,
					keys: "ctrl+d",
					description: "Exit the TUI",
					source: "default",
				},
			],
		};

		let overlayOptions: ListOverlayOptions | null = null;

		const mockTui = {
			showOverlay: (component: Component, _options?: OverlayOptions) => {
				const frame = component as unknown as { child: { options: ListOverlayOptions } };
				overlayOptions = frame.child.options;
				return {
					hide: () => {},
					setHidden: () => {},
					isHidden: () => false,
					focus: () => {},
					unfocus: () => {},
					isFocused: () => true,
				};
			},
			requestRender: () => {},
		} as unknown as TUI;

		openHelpOverlay(mockTui, mockManager, () => {});

		ok(overlayOptions);
		const items = (overlayOptions as ListOverlayOptions).items;

		// 1. Commands group row count equals commandReference() length
		const commandsItems = items.filter((item) => item.group === "Commands");
		strictEqual(commandsItems.length, commandReference().length);

		// 2. Keys group rows are populated
		const keysItems = items.filter((item) => item.group === "Keys");
		strictEqual(keysItems.length, 1);

		// 3. Keys row contains the known default binding (Exit the TUI / Ctrl+D)
		const exitRow = keysItems.find((item) => item.id === "clio.exit");
		ok(exitRow);
		ok(exitRow.label.includes("Ctrl+D") || exitRow.label.includes("ctrl+d"));
		ok(exitRow.label.includes("Exit the TUI"));
	});
});
