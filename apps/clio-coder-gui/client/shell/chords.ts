import { KEYBINDINGS, type Keybinding } from "../interaction/keybindings.js";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** A short, platform-true chord for the sidebar, e.g. "⇧⌘O" or "Ctrl ⇧ O". */
export function chordHint(id: keyof typeof KEYBINDINGS): string {
	const binding: Keybinding = KEYBINDINGS[id];
	const key = binding.key === "|" ? "\\" : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
	const parts: string[] = [];
	if (mac) {
		if (binding.modifiers.includes("alt")) parts.push("⌥");
		if (binding.modifiers.includes("shift")) parts.push("⇧");
		if (binding.modifiers.includes("primary")) parts.push("⌘");
		return `${parts.join("")}${key}`;
	}
	if (binding.modifiers.includes("primary")) parts.push("Ctrl");
	if (binding.modifiers.includes("alt")) parts.push("Alt");
	if (binding.modifiers.includes("shift")) parts.push("Shift");
	return [...parts, key].join("+");
}
