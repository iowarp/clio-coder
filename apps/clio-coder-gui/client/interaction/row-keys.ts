// The keyboard half of a row list: put `onKeyDown={moveRowFocus(".row")}` on the list's container and
// Up, Down, j, k, Home and End move focus between the matching rows.

import type { KeyboardEvent } from "react";
import { rowAfterKey } from "./row-keys-model.js";

const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

export function moveRowFocus(rowSelector: string) {
	return (event: KeyboardEvent<HTMLElement>) => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		// A text field types j and k, and a menu or popup trigger owns its own arrow keys.
		if (target.closest("[role='menu'], [role='listbox'], [aria-haspopup]:not([aria-haspopup='false'])")) return;
		if (target.closest(EDITABLE)) return;
		const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(rowSelector)].filter(
			(row) => row.matches("a[href], button:not([disabled])") && !row.closest("[hidden]"),
		);
		const exact = rows.indexOf(target);
		const at =
			exact >= 0
				? exact
				: rows.filter((row) => row.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).length;
		const next = rowAfterKey(event.key, { at, on: exact >= 0 }, rows.length);
		if (next < 0) return;
		event.preventDefault();
		rows[next]?.focus();
	};
}
