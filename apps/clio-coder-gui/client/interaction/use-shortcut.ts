// The scoped shortcut dispatcher. A layer stack replaces the hand-threaded `modalIsOpen` boolean,
// so a dialog silences every global binding for as long as it is open and the innermost layer wins.

import { type RefObject, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { KEYBINDINGS, type KeybindingId, matchesKeybinding, type ShortcutScope } from "./keybindings.js";
import { FOCUSABLE_SELECTOR } from "./use-focus-trap.js";

/** Layers currently claiming the keyboard, in the order they were pushed. */
const layers: { id: string; scope: ShortcutScope }[] = [];
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The scope a binding must declare to fire right now. */
function activeScope(): ShortcutScope {
	return layers.at(-1)?.scope ?? "global";
}

/**
 * Claim a keyboard layer for as long as `active` holds. A dialog and a drawer each claim one; while
 * any is claimed, `global` bindings do not fire, which is how Alt+A stops answering an approval from
 * inside a dialog whose own buttons must stay unambiguous. Layers are removed by id rather than
 * popped, because React does not guarantee unmount effect order between siblings.
 */
export function useShortcutLayer(scope: ShortcutScope, active: boolean): string {
	const id = useId();
	useEffect(() => {
		if (!active) return;
		layers.push({ id, scope });
		notify();
		return () => {
			const index = layers.findIndex((layer) => layer.id === id);
			if (index >= 0) layers.splice(index, 1);
			notify();
		};
	}, [id, scope, active]);
	return id;
}

/** True while the layer `id` is the innermost one: a dialog stacked on another owns Escape and Tab alone. */
export function isTopLayer(id: string): boolean {
	return layers.at(-1)?.id === id;
}

/** True while any layer is claimed. The shell reads this to inert and hide the obscured background. */
export function useLayersActive(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => layers.length > 0,
		() => false,
	);
}

export interface ShortcutOptions {
	/** Default true. Pass the precondition: an approval exists, a turn is running. */
	readonly enabled?: boolean;
	/** A layer id from `useShortcutLayer`: the binding fires only while that layer is the innermost. */
	readonly layer?: string;
}

/**
 * Bind one declared keybinding at document level. The handler runs only when the binding's scope is
 * the active layer's scope. `preventDefault` happens only after a match, so unbound keys always
 * reach the browser. The handler lives in a ref so a caller need not memoise it.
 */
export function useShortcut(
	id: KeybindingId,
	handler: (event: KeyboardEvent) => void,
	options: ShortcutOptions = {},
): void {
	const { enabled = true, layer } = options;
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		if (!enabled) return;
		const binding = KEYBINDINGS[id];
		const onKeyDown = (event: KeyboardEvent) => {
			if (activeScope() !== binding.scope) return;
			if (layer !== undefined && !isTopLayer(layer)) return;
			if (!matchesKeybinding(binding, event)) return;
			event.preventDefault();
			latest.current(event);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [id, enabled, layer]);
}

/** The control a menu opened from the keyboard starts on: its current choice, else its first live control. */
function focusMenu(details: HTMLDetailsElement): void {
	const controls = [...details.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(element) => element.tagName !== "SUMMARY",
	);
	const chosen = controls.find((element) => element.matches("input:checked, [aria-pressed='true']"));
	(chosen ?? controls[0] ?? details.querySelector("summary"))?.focus();
}

/**
 * Bind a chord that opens a `<details>` menu and moves focus into it. The caller's open state is set
 * directly as well as on the element, so the menu body renders in this commit instead of after the
 * element's asynchronous `toggle` event, and focus lands once it has.
 */
export function useMenuShortcut(
	id: KeybindingId,
	panel: RefObject<HTMLDetailsElement | null>,
	open: boolean,
	setOpen: (open: boolean) => void,
	options: ShortcutOptions = {},
): void {
	const pending = useRef(false);
	useShortcut(
		id,
		() => {
			const details = panel.current;
			if (!details) return;
			if (details.open) {
				focusMenu(details);
				return;
			}
			pending.current = true;
			details.open = true;
			setOpen(true);
		},
		options,
	);
	useEffect(() => {
		if (!open || !pending.current) return;
		pending.current = false;
		if (panel.current) focusMenu(panel.current);
	}, [open, panel]);
}
