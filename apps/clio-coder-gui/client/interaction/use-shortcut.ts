// The scoped shortcut dispatcher. A layer stack replaces the hand-threaded `modalIsOpen` boolean,
// so a dialog silences every global binding for as long as it is open and the innermost layer wins.

import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useSyncExternalStore,
} from "react";
import { KEYBINDINGS, type KeybindingId, matchesKeybinding, type ShortcutScope } from "./keybindings.js";

/** Layers currently claiming the keyboard, in the order they were pushed. */
const layers: { id: string; scope: ShortcutScope }[] = [];
const listeners = new Set<() => void>();
let revision = 0;

function notify(): void {
	revision += 1;
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
export function useShortcutLayer(scope: ShortcutScope, active: boolean): void {
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
}

/** True while any layer is claimed. The shell reads this to inert and hide the obscured background. */
export function useLayersActive(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => layers.length > 0,
		() => false,
	);
}

/** The current layer revision, for a caller that needs to recompute on any stack change. */
export function useLayerRevision(): number {
	return useSyncExternalStore(
		subscribe,
		() => revision,
		() => 0,
	);
}

export interface ShortcutOptions {
	/** Default true. Pass the precondition: an approval exists, a turn is running. */
	readonly enabled?: boolean;
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
	const { enabled = true } = options;
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		if (!enabled) return;
		const binding = KEYBINDINGS[id];
		const onKeyDown = (event: KeyboardEvent) => {
			if (activeScope() !== binding.scope) return;
			if (!matchesKeybinding(binding, event)) return;
			event.preventDefault();
			latest.current(event);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [id, enabled]);
}

/**
 * An element-local matcher for the bindings that must stay on their element rather than on the
 * document: composer send is the canonical case, because it depends on which field has focus.
 */
export function useElementShortcut(id: KeybindingId, handler: (event: ReactKeyboardEvent) => void) {
	const latest = useRef(handler);
	latest.current = handler;
	return useCallback(
		(event: ReactKeyboardEvent) => {
			if (!matchesKeybinding(KEYBINDINGS[id], event)) return;
			event.preventDefault();
			latest.current(event);
		},
		[id],
	);
}
