// The single declared table of keyboard chords. Handlers match against entries here, never against
// key literals, so a shortcut and the help reference that prints it can never drift apart.

export type KeyModifier = "primary" | "alt" | "shift";

/**
 * Where a binding is live. The dispatcher refuses to fire a binding whose scope is not the active
 * scope, which is how Escape-in-a-dialog and Alt+A-anywhere coexist without either one guessing.
 */
export type ShortcutScope = "global" | "composer" | "dialog" | "palette" | "list" | "interview";

export interface Keybinding {
	readonly id: string;
	/** `KeyboardEvent.key`, compared case-insensitively for single characters. */
	readonly key: string;
	/** `primary` is Ctrl on Linux and Windows and Cmd on macOS. */
	readonly modifiers: readonly KeyModifier[];
	readonly scope: ShortcutScope;
	readonly action: string;
	readonly where: string;
}

export const KEYBINDINGS = {
	interviewSubmit: {
		id: "interviewSubmit",
		key: "Enter",
		modifiers: ["primary"],
		scope: "interview",
		action: "Submit interview answers",
		where: "Interview · after reviewing every answer",
	},
	send: {
		id: "send",
		key: "Enter",
		modifiers: ["primary"],
		scope: "composer",
		action: "Send message",
		where: "Composer focused",
	},
	allowOnce: {
		id: "allowOnce",
		key: "a",
		modifiers: ["alt"],
		scope: "global",
		action: "Allow pending approval once",
		where: "Approval waiting · no dialog open",
	},
	reject: {
		id: "reject",
		key: "r",
		modifiers: ["alt"],
		scope: "global",
		action: "Reject pending approval",
		where: "Approval waiting · no dialog open",
	},
	escape: {
		id: "escape",
		key: "Escape",
		modifiers: [],
		scope: "dialog",
		action: "Close dialog or drawer",
		where: "Dialog or drawer open",
	},
	tabPrevious: {
		id: "tabPrevious",
		key: "ArrowLeft",
		modifiers: [],
		scope: "list",
		action: "Previous tab",
		where: "Tab focused",
	},
	tabNext: {
		id: "tabNext",
		key: "ArrowRight",
		modifiers: [],
		scope: "list",
		action: "Next tab",
		where: "Tab focused",
	},
	tabFirst: {
		id: "tabFirst",
		key: "Home",
		modifiers: [],
		scope: "list",
		action: "First tab",
		where: "Tab focused",
	},
	tabLast: {
		id: "tabLast",
		key: "End",
		modifiers: [],
		scope: "list",
		action: "Last tab",
		where: "Tab focused",
	},
	listNext: {
		id: "listNext",
		key: "ArrowDown",
		modifiers: [],
		scope: "list",
		action: "Next list row",
		where: "List focused · j also moves",
	},
	listPrevious: {
		id: "listPrevious",
		key: "ArrowUp",
		modifiers: [],
		scope: "list",
		action: "Previous list row",
		where: "List focused · k also moves",
	},
	palette: {
		id: "palette",
		key: "k",
		modifiers: ["primary"],
		scope: "global",
		action: "Command palette",
		where: "No dialog open",
	},
	help: {
		id: "help",
		key: "/",
		modifiers: ["primary"],
		scope: "global",
		action: "Keyboard shortcuts and help",
		where: "No dialog open",
	},
	sidebar: {
		id: "sidebar",
		key: "\\",
		modifiers: ["primary"],
		scope: "global",
		action: "Toggle sidebar",
		where: "No dialog open · also available in the sidebar",
	},
	newTask: {
		id: "newTask",
		key: "o",
		modifiers: ["primary", "shift"],
		scope: "global",
		action: "New task",
		where: "Current project · no dialog open",
	},
	newWindow: {
		id: "newWindow",
		key: "n",
		modifiers: ["primary", "shift"],
		scope: "global",
		action: "Open task in another window",
		where: "Installed app only · no dialog open; reserved by browser tabs",
	},
	openWorkspace: {
		id: "openWorkspace",
		key: "o",
		modifiers: ["primary"],
		scope: "global",
		action: "Open workspace folder",
		where: "No dialog open",
	},
	sessionPanel: {
		id: "sessionPanel",
		key: "|",
		modifiers: ["primary", "shift"],
		scope: "global",
		action: "Toggle task sidebar",
		where: "Conversation · no dialog open",
	},
	focusComposer: {
		id: "focusComposer",
		key: "l",
		modifiers: ["primary", "shift"],
		scope: "global",
		action: "Focus composer",
		where: "Conversation · no dialog open",
	},
	agents: {
		id: "agents",
		key: "a",
		modifiers: ["primary", "alt"],
		scope: "global",
		action: "Show live agents",
		where: "Conversation · no dialog open",
	},
	cancelTurn: {
		id: "cancelTurn",
		key: ".",
		modifiers: ["primary"],
		scope: "global",
		action: "Cancel running turn",
		where: "While a turn is running",
	},
} as const satisfies Readonly<Record<string, Keybinding>>;

export type KeybindingId = keyof typeof KEYBINDINGS;
export const KEYBINDING_ORDER: readonly Keybinding[] = Object.values(KEYBINDINGS);

/** Interviews own a separate shortcut scope so approval shortcuts cannot submit answers. */
export const INTERVIEW_KEYBINDING_NAMESPACE = "interview" as const;

/** The subset of a keyboard event the matcher reads; React and DOM events both satisfy it. */
export interface KeyEventLike {
	readonly key: string;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
}

function sameKey(binding: Keybinding, key: string): boolean {
	if (binding.key.length === 1 && key.length === 1) return binding.key.toLowerCase() === key.toLowerCase();
	return binding.key === key;
}

/**
 * True when the event is exactly this binding: the key, every listed modifier held, and no unlisted
 * modifier held. Exactness rather than "at least these" is what stops Alt+A firing during Ctrl+Alt+A.
 */
export function matchesKeybinding(binding: Keybinding, event: KeyEventLike): boolean {
	if (!sameKey(binding, event.key)) return false;
	const wantsPrimary = binding.modifiers.includes("primary");
	const wantsAlt = binding.modifiers.includes("alt");
	const wantsShift = binding.modifiers.includes("shift");
	const hasPrimary = event.ctrlKey || event.metaKey;
	if (wantsPrimary !== hasPrimary) return false;
	if (wantsAlt !== event.altKey) return false;
	if (wantsShift !== event.shiftKey) return false;
	return true;
}

const MODIFIER_LABELS: Readonly<Record<KeyModifier, string>> = {
	primary: "Ctrl or Cmd",
	alt: "Alt",
	shift: "Shift",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
	Enter: "Enter",
	"|": "\\",
	Escape: "Esc",
	ArrowLeft: "Left arrow",
	ArrowRight: "Right arrow",
	ArrowUp: "Up arrow",
	ArrowDown: "Down arrow",
	Home: "Home",
	End: "End",
};

/** The chord as the reference prints it, for example "Ctrl or Cmd + Enter". */
export function formatKeybinding(binding: Keybinding): string {
	const parts = binding.modifiers.map((modifier) => MODIFIER_LABELS[modifier]);
	parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
	return parts.join(" + ");
}
