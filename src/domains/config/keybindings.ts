/**
 * Clio app keybinding schema. Merges pi-tui's editor/select defaults (in
 * TUI_KEYBINDINGS) with the Clio-specific action ids so `KeybindingsManager`
 * can resolve both against user overrides stored in `settings.yaml`.
 *
 * The `Keybindings` interface in pi-tui is extensible via declaration merging.
 * Adding `clio.*` ids here makes them typed everywhere the manager is used:
 * pass a wrong id to `matches("clio.typo", ...)` and the compiler complains.
 */

import type { KeybindingDefinitions } from "../../engine/tui.js";
import { TUI_KEYBINDINGS } from "../../engine/tui.js";

/**
 * Clio-specific keybinding ids. Each entry represents a routable action in
 * `routeInteractiveKey`. Ctrl+C is intentionally absent because its three-way
 * semantics (cancel stream / close overlay / clear editor / double-tap exit)
 * live in `resolveCtrlCAction` and are not a simple keybinding.
 */
export interface ClioAppKeybindings {
	"clio.thinking.cycle": true;
	"clio.mode.cycle": true;
	"clio.exit": true;
	"clio.super.request": true;
	"clio.session.tree": true;
	"clio.dispatchBoard.toggle": true;
	"clio.model.select": true;
	"clio.model.cycleForward": true;
	"clio.model.cycleBackward": true;
	"clio.harness.restart": true;
	"clio.tool.expand": true;
	"clio.thinking.expand": true;
}

export type ClioKeybinding = keyof ClioAppKeybindings;

/**
 * Declaration merge: pi-tui's `Keybindings` interface is open so downstream
 * packages register their action ids. After this block, `KeybindingsManager`
 * returned from `createKeybindingManager` accepts `clio.*` ids with full
 * TypeScript checking.
 */
declare module "@mariozechner/pi-tui" {
	interface Keybindings extends ClioAppKeybindings {}
}

/**
 * Built-in defaults. Users override via `settings.yaml.keybindings`; the
 * manager reads those and patches this table before the TUI starts.
 *
 * Default key strings follow pi-tui's `KeyId` format (`modifier+modifier+key`,
 * lowercase). `shift+ctrl+p` uses kitty-protocol CSI-u; terminals without
 * CSI-u cannot fire it by design. Users can rebind to an alt combo or use
 * `/scoped-models` instead.
 */
export const CLIO_APP_KEYBINDINGS = {
	"clio.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle orchestrator thinking level",
	},
	"clio.mode.cycle": {
		defaultKeys: "alt+m",
		description: "Cycle between default and advise modes",
	},
	"clio.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit the TUI",
	},
	"clio.super.request": {
		defaultKeys: "alt+s",
		description: "Request super mode (requires confirmation)",
	},
	"clio.session.tree": {
		defaultKeys: "alt+t",
		description: "Open the /tree navigator",
	},
	"clio.dispatchBoard.toggle": {
		defaultKeys: "ctrl+b",
		description: "Toggle the dispatch board overlay",
	},
	"clio.model.select": {
		defaultKeys: "ctrl+l",
		description: "Open the model selector",
	},
	"clio.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next scoped model",
	},
	"clio.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: "Cycle to previous scoped model",
	},
	"clio.harness.restart": {
		defaultKeys: "ctrl+r",
		description: "Restart the dev harness when engine edits are pending",
	},
	"clio.tool.expand": {
		defaultKeys: "ctrl+o",
		description: "Toggle the most recent tool segment between collapsed subline and full body",
	},
	"clio.thinking.expand": {
		defaultKeys: "ctrl+t",
		description: "Toggle the most recent assistant turn's thinking block between collapsed preview and full body",
	},
} as const satisfies KeybindingDefinitions;

/** Full definition table = pi-tui editor/select defaults + Clio app ids. */
export const CLIO_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	...CLIO_APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

export const CLIO_APP_KEYBINDING_IDS = Object.keys(CLIO_APP_KEYBINDINGS) as ReadonlyArray<ClioKeybinding>;
