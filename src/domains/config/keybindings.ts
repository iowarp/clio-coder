/**
 * Clio app keybinding schema. Merges pi-tui's editor/select defaults (in
 * TUI_KEYBINDINGS) with the Clio-specific action ids so `KeybindingsManager`
 * can resolve both against user overrides stored in `settings.yaml`.
 *
 * The engine's ambient keybinding augmentation makes the Clio action IDs
 * typed everywhere the manager is used.
 */

import type { KeybindingDefinitions, KeyId } from "../../engine/tui.js";
import { TUI_KEYBINDINGS } from "../../engine/tui.js";

/**
 * Clio-specific keybinding ids. Each entry represents a routable action in the
 * application controller's `CLOSED_ACTION_ORDER` or `GLOBAL_ACTION_ORDER`.
 * Ctrl+C is intentionally absent because its semantics (cancel stream, close
 * overlay, clear editor, protect the queue, double-tap exit) live in the
 * controller's `resolveApplicationCtrlCAction` and are not a simple keybinding.
 */
export interface ClioAppKeybindings {
	"clio-coder.output.cycle": true;
	"clio-coder.thinking.cycle": true;
	"clio-coder.autonomy.toggle": true;
	"clio-coder.exit": true;
	"clio-coder.status.toggle": true;
	"clio-coder.session.tree": true;
	"clio-coder.dispatchBoard.toggle": true;
	"clio-coder.files.toggle": true;
	"clio-coder.music.toggle": true;
	"clio-coder.tasks.open": true;
	"clio-coder.decisions.open": true;
	"clio-coder.dispatch.background": true;
	"clio-coder.model.select": true;
	"clio-coder.library.toggle": true;
	"clio-coder.model.cycleForward": true;
	"clio-coder.model.cycleBackward": true;
	"clio-coder.editor.external": true;
	"clio-coder.message.interrupt": true;
	"clio-coder.message.dequeue": true;
	"clio-coder.queue.open": true;
	"clio-coder.notifications.dismiss": true;
	"clio-coder.leader": true;
}

export type ClioKeybinding = keyof ClioAppKeybindings;

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
		description: "Dashboard pages: Activity → Context → Status → closed",
		scope: "composer",
		kind: "cycle",
		repeat: false,
		leader: "u",
	},
	"clio-coder.dispatchBoard.toggle": {
		defaultKeys: "alt+w",
		description: "Workers dock: show or hide (twice quickly closes)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "w",
	},
	"clio-coder.files.toggle": {
		defaultKeys: "alt+e",
		description: "Files pane: show or hide (twice quickly closes)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "e",
	},
	"clio-coder.music.toggle": {
		defaultKeys: "alt+a",
		description: "Music pane: show or hide (twice quickly closes)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "a",
	},
	"clio-coder.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Thinking effort",
		scope: "composer",
		kind: "cycle",
		repeat: false,
		leader: "t",
	},
	"clio-coder.autonomy.toggle": {
		defaultKeys: [],
		description: "Toggle default / YOLO autonomy (this session)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "y",
	},
	"clio-coder.message.dequeue": {
		defaultKeys: "alt+q",
		description: "Restore queued messages",
		scope: "composer",
		kind: "send",
		repeat: false,
		leader: "q",
	},
	"clio-coder.queue.open": {
		// Not alt+up: pi-tui reads the legacy sequence ESC p as alt+up, so that
		// default would take Alt+P from every non-Kitty terminal.
		defaultKeys: "alt+k",
		description: "Queue navigator: reorder, edit, remove or send queued messages",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "n",
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
		// Not alt+enter: in legacy terminal mode it is the same bytes as the
		// shift+enter newline mapping many operators install.
		defaultKeys: "alt+s",
		description: "Send now: interrupt the run with the draft, or flush the queue",
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
	"tui.editor.cursorLineStart": {
		...TUI_KEYBINDINGS["tui.editor.cursorLineStart"],
		defaultKeys: ["home", "ctrl+home", "ctrl+a"],
	},
	"tui.editor.cursorLineEnd": {
		...TUI_KEYBINDINGS["tui.editor.cursorLineEnd"],
		defaultKeys: ["end", "ctrl+end", "ctrl+e"],
	},
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
