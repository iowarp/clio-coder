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
 * overlay, protect the queue, double-tap exit) live in the
 * controller's `resolveApplicationCtrlCAction` and are not a simple keybinding.
 */
export interface ClioAppKeybindings {
	"clio-coder.output.cycle": true;
	"clio-coder.thinking.cycle": true;
	"clio-coder.autonomy.toggle": true;
	"clio-coder.exit": true;
	"clio-coder.suspend": true;
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

/**
 * The keyboard model, in one rule each:
 *
 *   - Ctrl edits text and talks to the terminal (pi's editor defaults, a few portable overrides below).
 *   - Alt+<letter> runs a Clio action.
 *   - Ctrl+G then the same letter runs it in any terminal, including ones that do not deliver Alt.
 *   - `?` on an empty composer shows the card; `/help` lists everything.
 *
 * The menu letter equals the Alt letter for actions that have an Alt key; other actions are reached
 * through the menu only. Shift+Tab (thinking) is the one non-Alt direct key, kept from pi. Letters are
 * fixed: rebinding a direct key never moves its menu letter (keyboard-model contract test). `b` and
 * `j` stay free for an active extension workspace (surfaces/registry.ts).
 */
interface AppActionDescriptor {
	defaultKeys: KeyId | KeyId[];
	/** Short name every chrome surface shows: the `?` card, the menu, the footer and the welcome. */
	label: string;
	/** The sentence `/help` shows. */
	description: string;
	/** The slash command that does the same thing, when there is one. */
	command?: string;
	scope: "composer";
	kind: "toggle" | "cycle" | "send" | "exit" | "edit" | "dismiss";
	repeat: false;
	leader?: string;
}
/** Registry order is presentation order on the `?` card and in the Ctrl+G menu. */
export const CLIO_APP_KEYBINDINGS = {
	"clio-coder.model.select": {
		defaultKeys: "alt+m",
		label: "Model",
		description: "Model picker",
		command: "/model",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "m",
	},
	"clio-coder.thinking.cycle": {
		defaultKeys: "shift+tab",
		label: "Thinking effort",
		description: "Cycle thinking effort for this session",
		command: "/thinking",
		scope: "composer",
		kind: "cycle",
		repeat: false,
		leader: "t",
	},
	"clio-coder.output.cycle": {
		defaultKeys: "alt+o",
		label: "Output detail",
		description: "Cycle output detail: Minimal, Default, Detailed",
		scope: "composer",
		kind: "cycle",
		repeat: false,
		leader: "o",
	},
	"clio-coder.library.toggle": {
		defaultKeys: "alt+l",
		label: "Library",
		description: "Library: skills, agents, prompts, playbooks, plugins and extensions",
		command: "/library",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "l",
	},
	"clio-coder.status.toggle": {
		defaultKeys: "alt+u",
		label: "Dashboard",
		description: "Dashboard pages: Activity → Context → Status → closed",
		scope: "composer",
		kind: "cycle",
		repeat: false,
		leader: "u",
	},
	"clio-coder.dispatchBoard.toggle": {
		defaultKeys: "alt+w",
		label: "Workers",
		description: "Workers dock: show or hide (twice quickly closes); the Fleet Runs board without panes",
		command: "/fleet",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "w",
	},
	"clio-coder.files.toggle": {
		defaultKeys: "alt+e",
		label: "Files",
		description: "Files pane: show or hide (twice quickly closes)",
		command: "/files",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "e",
	},
	"clio-coder.music.toggle": {
		defaultKeys: "alt+a",
		label: "Music",
		description: "Music pane: show or hide (twice quickly closes)",
		command: "/music",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "a",
	},
	"clio-coder.message.interrupt": {
		// Not alt+enter: in legacy terminal mode it is the same bytes as the
		// shift+enter newline mapping many operators install.
		defaultKeys: "alt+s",
		label: "Send now",
		description: "Send now: interrupt the run with the draft, or flush the queue",
		scope: "composer",
		kind: "send",
		repeat: false,
		leader: "s",
	},
	"clio-coder.queue.open": {
		// Not alt+up: pi-tui reads the legacy sequence ESC p as alt+up, so that
		// default would take Alt+P from every non-Kitty terminal.
		defaultKeys: "alt+q",
		label: "Queue",
		description: "Queue: reorder, edit, remove or send queued messages; a puts them all back in the composer",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "q",
	},
	"clio-coder.editor.external": {
		defaultKeys: "alt+g",
		label: "External editor",
		description: "Edit the draft in $VISUAL or $EDITOR",
		scope: "composer",
		kind: "edit",
		repeat: false,
		leader: "g",
	},
	"clio-coder.dispatch.background": {
		defaultKeys: [],
		label: "Background worker",
		description: "Move the newest attached dispatch to the background",
		scope: "composer",
		kind: "send",
		repeat: false,
		leader: "d",
	},
	"clio-coder.notifications.dismiss": {
		defaultKeys: [],
		label: "Dismiss notice",
		description: "Dismiss the oldest notification",
		scope: "composer",
		kind: "dismiss",
		repeat: false,
		leader: "x",
	},
	"clio-coder.autonomy.toggle": {
		defaultKeys: [],
		label: "Autonomy",
		description: "Toggle default / YOLO autonomy (this session)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
		leader: "y",
	},
	"clio-coder.leader": {
		defaultKeys: "ctrl+g",
		label: "Actions menu",
		description: "Open the actions menu: then the same letter as any Alt shortcut",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.exit": {
		defaultKeys: "ctrl+d",
		label: "Exit",
		description: "Exit empty idle composer with no queued messages",
		command: "/quit",
		scope: "composer",
		kind: "exit",
		repeat: false,
	},
	"clio-coder.suspend": {
		defaultKeys: "ctrl+z",
		label: "Suspend",
		description: "Suspend Clio (resume with fg; unavailable on Windows)",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	// Rebindable hooks with no default key and no menu letter: their boards are slash commands.
	"clio-coder.message.dequeue": {
		defaultKeys: [],
		label: "Restore queue",
		description: "Put every queued message back in the composer (the queue's a)",
		scope: "composer",
		kind: "send",
		repeat: false,
	},
	"clio-coder.tasks.open": {
		defaultKeys: [],
		label: "Tasks",
		description: "Tasks (/tasks; ↓ on an empty composer)",
		command: "/tasks",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.decisions.open": {
		defaultKeys: [],
		label: "Decisions",
		description: "Decisions (/decisions)",
		command: "/decisions",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.session.tree": {
		defaultKeys: [],
		label: "Session tree",
		description: "Session tree (/tree)",
		command: "/tree",
		scope: "composer",
		kind: "toggle",
		repeat: false,
	},
	"clio-coder.model.cycleForward": {
		defaultKeys: [],
		label: "Next model",
		description: "Next scoped model",
		scope: "composer",
		kind: "cycle",
		repeat: false,
	},
	"clio-coder.model.cycleBackward": {
		defaultKeys: [],
		label: "Previous model",
		description: "Previous scoped model",
		scope: "composer",
		kind: "cycle",
		repeat: false,
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
	// alt+enter matches CSI 13;3u under the kitty protocol. Legacy ESC CR already
	// inserts a newline through the editor's hardcoded check, so without this
	// binding default Alt+Enter depended on the terminal (#389).
	"tui.input.newLine": {
		...TUI_KEYBINDINGS["tui.input.newLine"],
		defaultKeys: ["ctrl+j", "shift+enter", "alt+enter"],
	},
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

/** The app action a slash command duplicates, so a typed command can teach its key. */
export const ACTION_BY_COMMAND: ReadonlyMap<string, ClioKeybinding> = new Map(
	CLIO_APP_KEYBINDING_IDS.flatMap((id) => {
		const descriptor: AppActionDescriptor = CLIO_APP_KEYBINDINGS[id];
		// Only commands with a key worth learning: a menu letter or a direct default.
		return descriptor.command !== undefined && descriptor.leader !== undefined ? [[descriptor.command, id] as const] : [];
	}),
);
