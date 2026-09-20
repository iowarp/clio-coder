// The single declared table of keyboard chords. Handlers match against entries here, never against
// key literals, so a shortcut and the help reference that prints it can never drift apart.

export type KeyModifier = "primary" | "alt" | "shift";

/**
 * Where a binding is live. The dispatcher refuses to fire a binding whose scope is not the active
 * scope, which is how Escape-in-a-dialog and Alt+A-anywhere coexist without either one guessing.
 */
export type ShortcutScope = "global" | "composer" | "dialog" | "palette" | "list";

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
	send: {
		id: "send",
		key: "Enter",
		modifiers: ["primary"],
		scope: "composer",
		action: "Send the request in the composer",
		where: "While the composer has focus",
	},
	allowOnce: {
		id: "allowOnce",
		key: "a",
		modifiers: ["alt"],
		scope: "global",
		action: "Allow the pending approval once",
		where: "Anywhere, while an approval is waiting and no dialog is open",
	},
	reject: {
		id: "reject",
		key: "r",
		modifiers: ["alt"],
		scope: "global",
		action: "Reject the pending approval",
		where: "Anywhere, while an approval is waiting and no dialog is open",
	},
	escape: {
		id: "escape",
		key: "Escape",
		modifiers: [],
		scope: "dialog",
		action: "Close the open dialog or drawer",
		where: "While a dialog or a drawer is open",
	},
	tabPrevious: {
		id: "tabPrevious",
		key: "ArrowLeft",
		modifiers: [],
		scope: "list",
		action: "Move to the previous tab",
		where: "While a tab in a tablist has focus",
	},
	tabNext: {
		id: "tabNext",
		key: "ArrowRight",
		modifiers: [],
		scope: "list",
		action: "Move to the next tab",
		where: "While a tab in a tablist has focus",
	},
	tabFirst: {
		id: "tabFirst",
		key: "Home",
		modifiers: [],
		scope: "list",
		action: "Move to the first tab",
		where: "While a tab in a tablist has focus",
	},
	tabLast: {
		id: "tabLast",
		key: "End",
		modifiers: [],
		scope: "list",
		action: "Move to the last tab",
		where: "While a tab in a tablist has focus",
	},
	listNext: {
		id: "listNext",
		key: "ArrowDown",
		modifiers: [],
		scope: "list",
		action: "Move to the next row",
		where: "While a list has focus. j also moves",
	},
	listPrevious: {
		id: "listPrevious",
		key: "ArrowUp",
		modifiers: [],
		scope: "list",
		action: "Move to the previous row",
		where: "While a list has focus. k also moves",
	},
	palette: {
		id: "palette",
		key: "k",
		modifiers: ["primary"],
		scope: "global",
		action: "Open the command palette",
		where: "Anywhere except inside a dialog",
	},
	help: {
		id: "help",
		key: "/",
		modifiers: ["primary"],
		scope: "global",
		action: "Open the keyboard and vocabulary reference",
		where: "Anywhere except inside a dialog",
	},
	cancelTurn: {
		id: "cancelTurn",
		key: ".",
		modifiers: ["primary"],
		scope: "global",
		action: "Cancel the running turn",
		where: "Anywhere, while a turn is running",
	},
} as const satisfies Readonly<Record<string, Keybinding>>;

export type KeybindingId = keyof typeof KEYBINDINGS;
export const KEYBINDING_ORDER: readonly Keybinding[] = Object.values(KEYBINDINGS);

/**
 * Reserved: an interview Clio opens through `ask_user` is a different exchange from an intra-turn
 * approval, and its answers must never share Alt+A or Alt+R. Nothing binds these yet; the entry
 * exists so the reference and the surface land together.
 */
export const RESERVED_KEYBINDING_NAMESPACE = "interview" as const;

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

/** A binding with its key replaced, for a hook that reuses one entry on a second axis. */
export function withKey(binding: Keybinding, key: string): Keybinding {
	return { ...binding, key };
}
