// Tab containment and focus restoration for dialogs, drawers and inline panels that are not a
// native `<dialog>`. The containment branch handles the case hand-rolled traps get wrong: focus that
// has escaped the container entirely is pulled back to the end Tab was heading toward.

import { type RefObject, useEffect } from "react";

export const FOCUSABLE_SELECTOR =
	'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function focusableWithin(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
	);
}

/**
 * Keep Tab inside `container`. An empty container swallows Tab and focuses itself, which is why the
 * container must carry `tabIndex={-1}`.
 */
export function containTabKey(event: KeyboardEvent, container: HTMLElement): void {
	if (event.key !== "Tab") return;
	const focusable = focusableWithin(container);
	if (focusable.length === 0) {
		event.preventDefault();
		container.focus();
		return;
	}
	const first = focusable[0];
	const last = focusable.at(-1);
	if (!first || !last) return;
	const outside = !container.contains(document.activeElement);
	if (event.shiftKey && (document.activeElement === first || outside)) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && (document.activeElement === last || outside)) {
		event.preventDefault();
		first.focus();
	}
}

/**
 * Move focus into `container` on open, contain Tab while open, and return focus to whatever held it
 * when the trap closes. The restore is guarded on `isConnected` because the element that opened the
 * layer is often unmounted by the action that closed it. Pass `initial` to land somewhere other than
 * the first focusable control, which a destructive dialog should do.
 */
export function useFocusTrap(
	container: RefObject<HTMLElement | null>,
	active: boolean,
	initial?: RefObject<HTMLElement | null>,
): void {
	useEffect(() => {
		if (!active) return;
		const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const landing = initial?.current ?? container.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
		(landing ?? container.current)?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (container.current) containTabKey(event, container.current);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (previouslyFocused?.isConnected) previouslyFocused.focus();
		};
	}, [container, active, initial]);
}
