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

let nativeSizing: boolean | undefined;

/**
 * Grow with the draft until CSS applies its cap; after that, keep scrolling inside the field.
 *
 * Where the browser sizes a field to its content (`field-sizing`, see composer-box.css) there is
 * nothing to do. Elsewhere the field has to be measured at its natural height, and a field that
 * collapses to one line for that instant shrinks the whole dock: the transcript beside it grows,
 * clamps its scroll offset, and a followed conversation is left a draft's height above its live
 * edge with following turned off. The box is held at its current height while the field is
 * measured, so the transcript only ever sees the net change.
 */
export function fitComposerField(field: HTMLTextAreaElement | null): void {
	if (field === null) return;
	nativeSizing ??= typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");
	if (nativeSizing) return;
	const box = field.parentElement;
	if (box !== null) {
		box.style.minHeight = `${box.offsetHeight}px`;
		// Without this the held box would stretch its rows, and the field with them.
		box.style.alignContent = "start";
	}
	field.style.height = "auto";
	field.style.height = `${field.scrollHeight}px`;
	field.style.overflowY = field.scrollHeight > field.clientHeight ? "auto" : "hidden";
	if (box !== null) {
		box.style.minHeight = "";
		box.style.alignContent = "";
	}
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
