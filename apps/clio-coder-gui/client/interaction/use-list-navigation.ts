// Arrow, vim-key and type-ahead navigation over one list. Two modes share one index machine:
// `roving` moves real focus between rows, `activedescendant` keeps focus in a text input and moves
// only the aria pointer, which is what the command palette needs.

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ListMode = "roving" | "activedescendant";

export interface ListNavigationOptions<T> {
	readonly items: readonly T[];
	readonly getId: (item: T, index: number) => string;
	/** Text the type-ahead matches, usually the row's visible title. */
	readonly getLabel?: (item: T, index: number) => string;
	/** Names the list for assistive technology. Required: an unnamed listbox is unusable. */
	readonly label: string;
	readonly mode?: ListMode;
	/** Default true. Vim keys are off inside text inputs regardless. */
	readonly vimKeys?: boolean;
	readonly onChoose?: (item: T, index: number) => void;
	/** Default true. Wrapping a 200-row data list is disorienting, so those pass false. */
	readonly wrap?: boolean;
}

export interface ListContainerProps {
	readonly "aria-label": string;
	readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	readonly role?: "listbox";
	readonly tabIndex?: number;
	readonly "aria-activedescendant"?: string;
}

export interface ListItemProps {
	readonly id: string;
	readonly ref?: (node: HTMLElement | null) => void;
	readonly tabIndex?: number;
	readonly role?: "option";
	readonly "aria-selected"?: boolean;
}

const TYPE_AHEAD_WINDOW = 700;
const PAGE = 10;

function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function normalise(text: string): string {
	return text.toLocaleLowerCase("en-US");
}

export function useListNavigation<T>({
	items,
	getId,
	getLabel,
	label,
	mode = "roving",
	vimKeys = true,
	onChoose,
	wrap = true,
}: ListNavigationOptions<T>) {
	const [activeIndex, setActiveIndex] = useState(0);
	const nodes = useRef(new Map<string, HTMLElement>());
	const buffer = useRef("");
	const bufferTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const lastKey = useRef("");
	const bounded = items.length === 0 ? 0 : Math.min(activeIndex, items.length - 1);
	const ids = useMemo(() => items.map((item, index) => getId(item, index)), [items, getId]);
	const activeId = ids[bounded] ?? "";

	const clearBuffer = useCallback(() => {
		buffer.current = "";
		if (bufferTimer.current !== undefined) clearTimeout(bufferTimer.current);
		bufferTimer.current = undefined;
	}, []);
	useEffect(() => clearBuffer, [clearBuffer]);

	const settle = useCallback(
		(index: number) => {
			setActiveIndex(index);
			const id = ids[index];
			if (id === undefined) return;
			if (mode === "roving") nodes.current.get(id)?.focus();
			// `block: "nearest"` and no smooth behaviour: a held arrow key queues smooth scrolls
			// faster than they finish, and every motion must collapse under reduced motion anyway.
			else document.getElementById(id)?.scrollIntoView({ block: "nearest" });
		},
		[ids, mode],
	);

	const move = useCallback(
		(delta: number) => {
			if (items.length === 0) return;
			const next = wrap
				? (((bounded + delta) % items.length) + items.length) % items.length
				: Math.min(items.length - 1, Math.max(0, bounded + delta));
			settle(next);
		},
		[items.length, bounded, wrap, settle],
	);

	const typeAhead = useCallback(
		(character: string) => {
			if (!getLabel) return;
			if (bufferTimer.current !== undefined) clearTimeout(bufferTimer.current);
			buffer.current += normalise(character);
			bufferTimer.current = setTimeout(clearBuffer, TYPE_AHEAD_WINDOW);
			// A buffer of one repeated character is the standard "press a again for the next a"
			// gesture, not a search for the literal string.
			const repeated = buffer.current.length > 1 && [...buffer.current].every((one) => one === buffer.current[0]);
			const needle = repeated ? (buffer.current[0] ?? "") : buffer.current;
			const from = repeated || buffer.current.length === 1 ? bounded + 1 : bounded;
			for (let step = 0; step < items.length; step += 1) {
				const index = (from + step + items.length) % items.length;
				const item = items[index];
				if (item === undefined) continue;
				if (normalise(getLabel(item, index)).startsWith(needle)) {
					settle(index);
					return;
				}
			}
		},
		[getLabel, items, bounded, settle, clearBuffer],
	);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			const editable = isEditable(event.target);
			const vim = vimKeys && !editable;
			const key = event.key;
			const choose = () => {
				const item = items[bounded];
				if (item !== undefined) onChoose?.(item, bounded);
			};
			if (key === "ArrowDown" || (vim && key === "j")) move(1);
			else if (key === "ArrowUp" || (vim && key === "k")) move(-1);
			else if (key === "PageDown") move(PAGE);
			else if (key === "PageUp") move(-PAGE);
			else if (key === "Home") settle(0);
			else if (key === "End") settle(Math.max(0, items.length - 1));
			else if (vim && key === "G" && event.shiftKey) settle(Math.max(0, items.length - 1));
			else if (vim && key === "g" && lastKey.current === "g") settle(0);
			else if (key === "Enter" || (key === " " && !editable)) choose();
			else if (key === "Escape") {
				// Escape only clears the type-ahead here; whichever layer is open owns closing.
				if (buffer.current.length === 0) {
					lastKey.current = key;
					return;
				}
				clearBuffer();
			} else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
				lastKey.current = key;
				typeAhead(key);
				return;
			} else {
				lastKey.current = key;
				return;
			}
			lastKey.current = key;
			event.preventDefault();
		},
		[items, bounded, move, settle, typeAhead, clearBuffer, onChoose, vimKeys],
	);

	const register = useCallback(
		(id: string) => (node: HTMLElement | null) => {
			if (node) nodes.current.set(id, node);
			else nodes.current.delete(id);
		},
		[],
	);

	const containerProps: ListContainerProps = {
		"aria-label": label,
		onKeyDown,
		...(mode === "activedescendant" ? { role: "listbox" as const, tabIndex: 0, "aria-activedescendant": activeId } : {}),
	};

	const itemProps = useCallback(
		(index: number): ListItemProps => {
			const id = ids[index] ?? "";
			return mode === "roving"
				? { id, ref: register(id), tabIndex: index === bounded ? 0 : -1 }
				: { id, role: "option" as const, "aria-selected": index === bounded };
		},
		[ids, mode, bounded, register],
	);

	return { activeIndex: bounded, setActiveIndex, activeId, onKeyDown, containerProps, itemProps };
}
