// Roving tabindex for a tablist or a toolbar: exactly one member is tabbable, arrows move between
// members with wraparound, and Tab enters and leaves the whole group in one stop.

import { type KeyboardEvent, useCallback, useRef } from "react";
import { KEYBINDINGS, matchesKeybinding, withKey } from "./keybindings.js";

const VERTICAL_PREVIOUS = withKey(KEYBINDINGS.tabPrevious, "ArrowUp");
const VERTICAL_NEXT = withKey(KEYBINDINGS.tabNext, "ArrowDown");

export interface RovingOptions<Id extends string> {
	readonly items: readonly Id[];
	readonly active: Id;
	readonly onActivate: (id: Id) => void;
	/** "horizontal" uses Left/Right, "vertical" Up/Down. Default horizontal. */
	readonly orientation?: "horizontal" | "vertical";
}

export function useRovingTabindex<Id extends string>({
	items,
	active,
	onActivate,
	orientation = "horizontal",
}: RovingOptions<Id>) {
	const nodes = useRef(new Map<Id, HTMLElement>());
	const register = useCallback(
		(id: Id) => (node: HTMLElement | null) => {
			if (node) nodes.current.set(id, node);
			else nodes.current.delete(id);
		},
		[],
	);
	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			const index = items.indexOf(active);
			const previous = orientation === "horizontal" ? KEYBINDINGS.tabPrevious : VERTICAL_PREVIOUS;
			const next = orientation === "horizontal" ? KEYBINDINGS.tabNext : VERTICAL_NEXT;
			let nextIndex: number;
			if (matchesKeybinding(previous, event)) nextIndex = (index - 1 + items.length) % items.length;
			else if (matchesKeybinding(next, event)) nextIndex = (index + 1) % items.length;
			else if (matchesKeybinding(KEYBINDINGS.tabFirst, event)) nextIndex = 0;
			else if (matchesKeybinding(KEYBINDINGS.tabLast, event)) nextIndex = items.length - 1;
			else return;
			event.preventDefault();
			const id = items[nextIndex];
			if (id === undefined) return;
			// Automatic activation: the panel swaps as the operator arrows, no Enter needed.
			onActivate(id);
			nodes.current.get(id)?.focus();
		},
		[items, active, onActivate, orientation],
	);
	/** Spread onto each tab button. */
	const tabProps = useCallback(
		(id: Id) => ({
			ref: register(id),
			role: "tab" as const,
			"aria-selected": id === active,
			tabIndex: id === active ? 0 : -1,
			onKeyDown,
			onClick: () => onActivate(id),
		}),
		[register, active, onKeyDown, onActivate],
	);
	return { tabProps };
}
