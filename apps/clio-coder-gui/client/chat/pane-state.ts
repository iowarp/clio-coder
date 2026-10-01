// Whether the pane is open and which view it shows, kept per browser like the sidebar and theme.

import { useCallback, useEffect, useRef, useState } from "react";
import { migratedPaneView, type PaneView } from "./pane-model.js";

const VIEW_KEY = "clio-coder-gui-pane-view";
const OPEN_KEY = "clio-coder-gui-pane";
// The previous panel's keys. Read once so an existing preference survives the move.
const OLD_VIEW_KEY = "clio-coder-gui-session-panel-view";
const OLD_OPEN_KEY = "clio-coder-gui-session-panel";

function initialView(): PaneView {
	try {
		return migratedPaneView(localStorage.getItem(VIEW_KEY) ?? localStorage.getItem(OLD_VIEW_KEY));
	} catch {
		return "progress";
	}
}

function initialOpen(): boolean {
	try {
		const saved = localStorage.getItem(OPEN_KEY) ?? localStorage.getItem(OLD_OPEN_KEY);
		if (saved === "open" || saved === "closed") return saved === "open";
	} catch {
		// Fall through to the width-based default.
	}
	// With no preference, a wide window shows the pane and a narrow one keeps the conversation whole.
	return typeof matchMedia === "function" && matchMedia("(min-width: 1280px)").matches;
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
		try {
			localStorage.setItem(OPEN_KEY, open ? "open" : "closed");
		} catch {
			// The preference holds in this tab.
		}
	}, [open]);
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
