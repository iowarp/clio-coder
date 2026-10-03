// Whether the right sidebar is expanded on a wide screen. It is a per-browser preference like the
// left rail's, shared by the shell (which lays out the column) and the pages that fill it.

import { useSyncExternalStore } from "react";

const ASIDE_KEY = "clio-coder-gui-aside";
const listeners = new Set<() => void>();

function read(): boolean {
	try {
		return localStorage.getItem(ASIDE_KEY) !== "collapsed";
	} catch {
		// The sidebar shows when storage is unavailable.
		return true;
	}
}

let expanded = read();

export function setAsideExpanded(next: boolean): void {
	if (next === expanded) return;
	expanded = next;
	try {
		localStorage.setItem(ASIDE_KEY, next ? "expanded" : "collapsed");
	} catch {
		// The choice holds for this tab.
	}
	for (const listener of listeners) listener();
}

export function toggleAside(): void {
	setAsideExpanded(!expanded);
}

export function useAsideExpanded(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => expanded,
		() => true,
	);
}

/** The width at which the right sidebar docks beside the work; narrower, it opens over it. */
export const ASIDE_DOCK_QUERY = "(min-width: 1440px)";
