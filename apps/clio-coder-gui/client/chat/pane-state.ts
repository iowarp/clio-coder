// Whether the pane is open and which view it shows, with dismissal kept for the current tab.

import { useCallback, useEffect, useRef, useState } from "react";
import { migratedPaneView, type PaneView } from "./pane-model.js";

const VIEW_KEY = "clio-coder-gui-pane-view";
const OPEN_KEY = "clio-coder-gui-pane";
// The previous panel's keys. Read once so an existing preference survives the move.
const OLD_VIEW_KEY = "clio-coder-gui-session-panel-view";
const DOCK_QUERY = "(min-width: 1100px)";

function initialView(): PaneView {
	try {
		return migratedPaneView(localStorage.getItem(VIEW_KEY) ?? localStorage.getItem(OLD_VIEW_KEY));
	} catch {
		return "progress";
	}
}

function initialOpen(): boolean {
	if (typeof matchMedia !== "function" || !matchMedia(DOCK_QUERY).matches) return false;
	try {
		return sessionStorage.getItem(OPEN_KEY) !== "closed";
	} catch {
		// A docked pane stays visible when storage is unavailable.
		return true;
	}
}

function rememberOpen(open: boolean): void {
	try {
		sessionStorage.setItem(OPEN_KEY, open ? "open" : "closed");
	} catch {
		// The explicit choice still holds until this view unmounts.
	}
}

export interface PaneState {
	readonly open: boolean;
	readonly view: PaneView;
	/** Open the pane on a view. `trigger` is the id of the control to return focus to on close. */
	show(view: PaneView, trigger: string): void;
	/** Open the pane, or close it when it is already showing this view. */
	toggle(view: PaneView, trigger: string): void;
	close(): void;
	setView(view: PaneView): void;
}

export function usePaneState(fallbackTrigger: string): PaneState {
	const [view, setViewState] = useState<PaneView>(initialView);
	const [open, setOpen] = useState(initialOpen);
	const opener = useRef<string | null>(null);
	useEffect(() => {
		const query = matchMedia(DOCK_QUERY);
		const change = () => setOpen(initialOpen());
		query.addEventListener("change", change);
		return () => query.removeEventListener("change", change);
	}, []);
	const setView = useCallback((next: PaneView) => {
		setViewState(next);
		try {
			localStorage.setItem(VIEW_KEY, next);
		} catch {
			// The preference holds in this tab.
		}
	}, []);
	const close = useCallback(() => {
		const dismissed = document.activeElement;
		setOpen(false);
		rememberOpen(false);
		requestAnimationFrame(() => {
			const current = document.activeElement;
			if (current === dismissed || current === document.body || current?.closest(".pane"))
				document.getElementById(opener.current ?? fallbackTrigger)?.focus();
		});
	}, [fallbackTrigger]);
	const show = useCallback(
		(next: PaneView, trigger: string) => {
			opener.current = trigger;
			setView(next);
			setOpen(true);
			rememberOpen(true);
		},
		[setView],
	);
	const toggle = useCallback(
		(next: PaneView, trigger: string) => {
			if (open && view === next) close();
			else show(next, trigger);
		},
		[open, view, close, show],
	);
	return { open, view, show, toggle, close, setView };
}
