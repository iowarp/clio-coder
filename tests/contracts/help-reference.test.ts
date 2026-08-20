import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioKeybinding } from "../../src/domains/config/keybindings.js";
import type { Component, OverlayOptions, TUI } from "../../src/engine/tui.js";
import type { ClioKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { openHelpOverlay } from "../../src/interactive/overlays/help-reference.js";
import type { ListOverlayOptions } from "../../src/interactive/overlays/list-overlay.js";
import { commandReference, parseSlashCommand, SLASH_COMMAND_GROUPS } from "../../src/interactive/slash-commands.js";

describe("contracts/help-reference", () => {
	it("ensures /hotkeys is no longer a command and fails rather than reaching the model", () => {
		const cmd = parseSlashCommand("/hotkeys");
		strictEqual(cmd.kind, "unknown-command");
		if (cmd.kind === "unknown-command") {
			strictEqual(cmd.token, "hotkeys");
		} else {
			throw new Error("expected unknown-command");
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

		// 1. Commands are grouped by verb, in SLASH_COMMAND_GROUPS order, and every
		//    registry entry appears exactly once.
		const commandsItems = items.filter((item) => SLASH_COMMAND_GROUPS.some((group) => group === item.group));
		strictEqual(commandsItems.length, commandReference().length);
		const groupOrder = commandsItems.map((item) => SLASH_COMMAND_GROUPS.indexOf(item.group as never));
		deepStrictEqual(
			groupOrder,
			[...groupOrder].sort((a, b) => a - b),
		);
		strictEqual(new Set(commandsItems.map((item) => item.group)).size, SLASH_COMMAND_GROUPS.length);
		strictEqual(commandsItems.find((item) => item.id === "targets")?.group, "Configure");
		strictEqual(commandsItems.find((item) => item.id === "run")?.group, "Run");

		// 2. Keys group rows are populated
		const keysItems = items.filter((item) => item.group === "Keys");
		strictEqual(keysItems.length, 1);

		// 3. Keys row contains the known default binding (Exit the TUI / Ctrl+D)
		const exitRow = keysItems.find((item) => item.id === "clio.exit");
		ok(exitRow);
		ok(exitRow.label.includes("Ctrl+D") || exitRow.label.includes("ctrl+d"));
		ok(exitRow.label.includes("Exit the TUI"));

		// 4. Topics group carries the autonomy, steering-mode, and fleet-control concept entries.
		const topicsItems = items.filter((item) => item.group === "Topics");
		strictEqual(topicsItems.length, 3);
		const fleetTopic = topicsItems.find((item) => item.id === "topic-fleet-runs");
		ok(fleetTopic);
		ok(fleetTopic.label.includes("fleet runs & steering"));
		ok(fleetTopic.detail);
		const fleetDetail = fleetTopic.detail(80).join("\n");
		ok(fleetDetail.includes("`@<runId> `"));
		ok(fleetDetail.includes("press `x`"));
		ok(fleetDetail.includes("ACP delegation runs cannot accept live steering"));
		ok(fleetDetail.includes("`/tasks` shows the agent's plan steps"));

		const autonomyTopic = topicsItems.find((item) => item.id === "topic-autonomy");
		ok(autonomyTopic);
		ok(autonomyTopic.label.includes("autonomy & safety net"));
		ok(autonomyTopic.detail);
		const detailText = autonomyTopic.detail(80).join("\n");
		ok(detailText.includes("**Tool surface**"));
		ok(detailText.includes("Violations are terminal denials, never approvable."));
		ok(detailText.includes("**Safety net** (always on, level-independent)"));
		ok(detailText.includes("auto-edit parks unrecognized commands"));
		ok(detailText.includes("Workers resolve asks per `workers.onPermission` (Approvals Routing)"));
	});
});
