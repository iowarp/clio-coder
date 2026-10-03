// What the conversation composer and the new-task screen share about their field: what Enter does,
// the stored Enter preference, and how the field grows. It is kept apart from `composer-model.ts`
// because the shell loads that module lazily with the task screen, and the new-task screen needs
// only this much of it up front. Nothing here touches the DOM or storage at import time, so
// `tests/chat-composer.test.ts` still reaches the Enter policy under plain node:test.

import type { KeyEventLike } from "../interaction/keybindings.js";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";

const ENTER_SENDS_KEY = "clio-coder-enter-sends";

/** The stored choice, or Enter-sends on a fine pointer where a hardware keyboard is the likely input. */
export function initialEnterSends(): boolean {
	try {
		const saved = localStorage.getItem(ENTER_SENDS_KEY);
		if (saved === "true" || saved === "false") return saved === "true";
	} catch {
		// The choice still works for this page when browser storage is unavailable.
	}
	return typeof matchMedia !== "function" || matchMedia("(pointer: fine)").matches;
}

export function rememberEnterSends(enterSends: boolean): void {
	try {
		localStorage.setItem(ENTER_SENDS_KEY, String(enterSends));
	} catch {
		// The in-memory choice remains usable.
	}
}

/** Grow with the draft until CSS applies its cap; after that, keep scrolling inside the field. */
export function fitComposerField(field: HTMLTextAreaElement | null): void {
	if (field === null) return;
	field.style.height = "auto";
	field.style.height = `${field.scrollHeight}px`;
	field.style.overflowY = field.scrollHeight > field.clientHeight ? "auto" : "hidden";
}

export type ComposerKeyAction = "send" | "newline" | "ignore";

export interface ComposerKeyContext {
	/** True while a dialog, the palette or any other layer owns the keyboard. */
	readonly layerOwned: boolean;
	/** True mid-IME-composition, where Enter commits a candidate and must never send. */
	readonly composing: boolean;
	/** False when plain Enter should add a line, as on touch keyboards or by operator choice. */
	readonly plainEnterSends?: boolean;
}

/**
 * Enter follows the operator's composer choice, Shift+Enter inserts a newline,
 * and the declared `send` chord (Ctrl or Cmd + Enter) always sends so the
 * registry's own binding keeps working from the composer.
 *
 * Plain Enter is deliberately NOT a registry entry. `tests/interaction.test.ts`
 * asserts the table never binds a bare printable key, and rightly so: a bare
 * Enter is a composer-local policy that depends on which field has focus, not a
 * document-level chord. The registry keeps the chord; this keeps the policy.
 */
export function composerKeyAction(event: KeyEventLike, context: ComposerKeyContext): ComposerKeyAction {
	if (event.key !== "Enter") return "ignore";
	if (context.composing) return "newline";
	if (context.layerOwned) return "newline";
	if (matchesKeybinding(KEYBINDINGS.send, event)) return "send";
	if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return "newline";
	return context.plainEnterSends === false ? "newline" : "send";
}
