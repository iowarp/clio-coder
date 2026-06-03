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
	"clio.status.toggle": true;
	"clio.session.tree": true;
	"clio.dispatchBoard.toggle": true;
	"clio.model.select": true;
	"clio.model.cycleForward": true;
	"clio.model.cycleBackward": true;
	"clio.tool.expand": true;
	"clio.thinking.expand": true;
	"clio.editor.external": true;
	"clio.message.followUp": true;
	"clio.message.dequeue": true;
	"clio.notifications.dismiss": true;
}

export type ClioKeybinding = keyof ClioAppKeybindings;

/**
 * Declaration merge: pi-tui's `Keybindings` interface is open so downstream
 * packages register their action ids. After this block, `KeybindingsManager`
 * returned from `createKeybindingManager` accepts `clio.*` ids with full
 * TypeScript checking.
 */
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends ClioAppKeybindings {}
}

/**
 * Built-in defaults. Users override via `settings.yaml.keybindings`; the
 * manager reads those and patches this table before the TUI starts.
 *
 * Clio's app bindings follow one scheme: `Alt + <key>` (with `shift+tab` and
 * `ctrl+d` retained because pi-tui and every terminal already expect them).
 * `Alt + <letter>` decodes from the legacy `ESC <letter>` sequence on any
 * terminal, so none of these defaults need kitty-protocol CSI-u. The chosen
 * letters avoid pi-tui's editor reserves (`alt+b/f/d/y`, and the
 * `ESC n`/`ESC p` aliases for `alt+down`/`alt+up`) and the readline/terminal
 * line-editing reserves (`ctrl+u/l/p/t/o/g/k/w/a/e`). The CSI-u/reserved-key
 * detector in `keybinding-manager.ts` stays as a safety net for user rebinds.
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
	"clio.status.toggle": {
		defaultKeys: "alt+u",
		description: "Toggle the footer dashboard (compact / expanded)",
	},
	"clio.session.tree": {
		defaultKeys: "alt+t",
		description: "Open the /tree navigator",
	},
	"clio.dispatchBoard.toggle": {
		defaultKeys: "alt+w",
		description: "Toggle the dispatch (workers) board overlay",
	},
	"clio.model.select": {
		defaultKeys: "alt+l",
		description: "Open the model + targets selector",
	},
	"clio.model.cycleForward": {
		defaultKeys: "alt+j",
		description: "Cycle to next scoped model",
	},
	"clio.model.cycleBackward": {
		defaultKeys: "alt+k",
		description: "Cycle to previous scoped model",
	},
	"clio.tool.expand": {
		defaultKeys: "alt+o",
		description: "Toggle the most recent tool segment between collapsed subline and full body",
	},
	"clio.thinking.expand": {
		defaultKeys: "alt+r",
		description: "Toggle thinking blocks between hidden marker and full body",
	},
	"clio.editor.external": {
		defaultKeys: "alt+g",
		description: "Open the current input in an external editor",
	},
	"clio.message.followUp": {
		defaultKeys: "alt+enter",
		description: "Queue the current input as a follow-up message",
	},
	"clio.message.dequeue": {
		defaultKeys: "alt+up",
		description: "Restore queued follow-up messages to the editor",
	},
	"clio.notifications.dismiss": {
		defaultKeys: "alt+x",
		description: "Dismiss footer notifications",
	},
} as const satisfies KeybindingDefinitions;

/** Full definition table = pi-tui editor/select defaults + Clio app ids. */
export const CLIO_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	...CLIO_APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

export const CLIO_APP_KEYBINDING_IDS = Object.keys(CLIO_APP_KEYBINDINGS) as ReadonlyArray<ClioKeybinding>;
