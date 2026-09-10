/**
 * Clio app keybinding schema. Merges pi-tui's editor/select defaults (in
 * TUI_KEYBINDINGS) with the Clio-specific action ids so `KeybindingsManager`
 * can resolve both against user overrides stored in `settings.yaml`.
 *
 * The `Keybindings` interface in pi-tui is extensible via declaration merging.
 * Adding `clio-coder.*` ids here makes them typed everywhere the manager is
 * used: pass a wrong id to `matches("clio-coder.typo", ...)` and the compiler
 * complains.
 */

import type { KeybindingDefinitions, KeyId } from "../../engine/tui.js";
import { TUI_KEYBINDINGS } from "../../engine/tui.js";

/**
 * Clio-specific keybinding ids. Each entry represents a routable action in
 * `routeInteractiveKey`. Ctrl+C is intentionally absent because its three-way
 * semantics (cancel stream / close overlay / clear editor / double-tap exit)
 * live in `resolveCtrlCAction` and are not a simple keybinding.
 */
export interface ClioAppKeybindings {
	"clio-coder.output.cycle": true;
	"clio-coder.thinking.cycle": true;
	"clio-coder.exit": true;
	"clio-coder.status.toggle": true;
	"clio-coder.session.tree": true;
	"clio-coder.dispatchBoard.toggle": true;
	"clio-coder.files.toggle": true;
	"clio-coder.tasks.open": true;
	"clio-coder.decisions.open": true;
	"clio-coder.dispatch.background": true;
	"clio-coder.model.select": true;
	"clio-coder.library.toggle": true;
	"clio-coder.model.cycleForward": true;
	"clio-coder.model.cycleBackward": true;
	"clio-coder.editor.external": true;
	"clio-coder.message.followUp": true;
	"clio-coder.message.interrupt": true;
	"clio-coder.message.dequeue": true;
	"clio-coder.notifications.dismiss": true;
	"clio-coder.leader": true;
}

export type ClioKeybinding = keyof ClioAppKeybindings;

/**
 * Declaration merge: pi-tui's `Keybindings` interface is open so downstream
 * packages register their action ids. After this block, `KeybindingsManager`
 * returned from `createKeybindingManager` accepts `clio-coder.*` ids with full
 * TypeScript checking.
 */
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends ClioAppKeybindings {}
}

/** Stable application descriptors. Fixed leader suffixes never derive from overrides. */
interface AppActionDescriptor {
	defaultKeys: KeyId | KeyId[];
	description: string;
	scope: "composer";
	kind: "toggle" | "cycle" | "send" | "exit" | "edit" | "dismiss";
	repeat: false;
	leader?: string;
}
export const CLIO_APP_KEYBINDINGS = {
	"clio-coder.library.toggle": {
		defaultKeys: "alt+l",
		description: "Library",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "l",
	},
	"clio-coder.model.select": {
		defaultKeys: "alt+m",
		description: "Model picker",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "m",
	},
	"clio-coder.output.cycle": {
		defaultKeys: "alt+o",
		description: "Output style",
		scope: "composer",
		kind: "cycle",
		repeat: false,
		leader: "o",
	},
	"clio-coder.status.toggle": {
		defaultKeys: "alt+u",
		description: "Dashboard",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "u",
	},
	"clio-coder.dispatchBoard.toggle": {
		defaultKeys: "alt+w",
		description: "Workers",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "w",
	},
	"clio-coder.files.toggle": {
		defaultKeys: "alt+e",
		description: "Files (from Clio focus)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "e",
	},
	"clio-coder.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Thinking effort",
		scope: "composer",
		kind: "cycle",
		repeat: false,
		leader: "t",
	},
	"clio-coder.message.followUp": {
		defaultKeys: "ctrl+q",
		description: "Send after the active run",
		scope: "composer",
		kind: "send",
		repeat: false,
		leader: "f",
	},
	"clio-coder.message.dequeue": {
		defaultKeys: "alt+q",
		description: "Restore queued messages",
		scope: "composer",
		kind: "send",
		repeat: false,
		leader: "q",
	},
	"clio-coder.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit empty idle composer with no queued messages",
		scope: "composer",
		kind: "exit",
		repeat: false,
	},
	"clio-coder.leader": {
		defaultKeys: "ctrl+g",
		description: "Open contextual action menu",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.tasks.open": {
		defaultKeys: [],
		description: "Tasks (/tasks)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.decisions.open": {
		defaultKeys: [],
		description: "Decisions (/decisions)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.session.tree": {
		defaultKeys: [],
		description: "Session tree (/tree)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.model.cycleForward": {
		defaultKeys: [],
		description: "Next scoped model",
		scope: "composer",
		kind: "cycle",
		repeat: false,
	},
	"clio-coder.model.cycleBackward": {
		defaultKeys: [],
		description: "Previous scoped model",
		scope: "composer",
		kind: "cycle",
		repeat: false,
	},
	"clio-coder.dispatch.background": {
		defaultKeys: [],
		description: "Background attached dispatch",
		scope: "composer",
		kind: "send",
		repeat: false,
		leader: "s",
	},
	"clio-coder.message.interrupt": {
		defaultKeys: [],
		description: "Interrupt with draft",
		scope: "composer",
		kind: "send",
		repeat: false,
		leader: "i",
	},
	"clio-coder.editor.external": {
		defaultKeys: [],
		description: "Edit expanded draft externally",
		scope: "composer",
		kind: "edit",
		repeat: false,
		leader: "g",
	},
	"clio-coder.notifications.dismiss": {
		defaultKeys: [],
		description: "Dismiss oldest notification",
		scope: "composer",
		kind: "dismiss",
		repeat: false,
		leader: "x",
	},
} as const satisfies Record<ClioKeybinding, AppActionDescriptor>;

export const CLIO_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"tui.editor.historyPrevious": { ...TUI_KEYBINDINGS["tui.editor.historyPrevious"], defaultKeys: "ctrl+p" },
	"tui.editor.historyNext": { ...TUI_KEYBINDINGS["tui.editor.historyNext"], defaultKeys: "ctrl+n" },
	"tui.editor.deleteWordBackward": {
		...TUI_KEYBINDINGS["tui.editor.deleteWordBackward"],
		defaultKeys: ["ctrl+w", "alt+backspace", "ctrl+backspace"],
	},
	"tui.editor.undo": { ...TUI_KEYBINDINGS["tui.editor.undo"], defaultKeys: "ctrl+_" },
	"tui.input.newLine": { ...TUI_KEYBINDINGS["tui.input.newLine"], defaultKeys: ["ctrl+j", "shift+enter"] },
	"tui.altScreen.top": { ...TUI_KEYBINDINGS["tui.altScreen.top"], defaultKeys: [] },
	"tui.altScreen.bottom": { ...TUI_KEYBINDINGS["tui.altScreen.bottom"], defaultKeys: [] },
	"tui.altScreen.previousPrompt": { ...TUI_KEYBINDINGS["tui.altScreen.previousPrompt"], defaultKeys: "ctrl+up" },
	"tui.altScreen.nextPrompt": { ...TUI_KEYBINDINGS["tui.altScreen.nextPrompt"], defaultKeys: "ctrl+down" },
	"tui.altScreen.search": { ...TUI_KEYBINDINGS["tui.altScreen.search"], defaultKeys: "ctrl+r" },
	"tui.altScreen.searchNext": { ...TUI_KEYBINDINGS["tui.altScreen.searchNext"], defaultKeys: "enter" },
	"tui.altScreen.searchPrevious": { ...TUI_KEYBINDINGS["tui.altScreen.searchPrevious"], defaultKeys: "up" },
	...CLIO_APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

export const CLIO_APP_KEYBINDING_IDS = Object.keys(CLIO_APP_KEYBINDINGS) as ReadonlyArray<ClioKeybinding>;
