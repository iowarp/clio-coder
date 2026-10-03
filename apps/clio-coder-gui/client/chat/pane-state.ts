// Whether the pane is open and which view it shows, with dismissal kept for the current tab.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type PaneSection, type PaneTarget, paneTargetParts } from "./pane-context.js";
import { migratedPaneView, type PaneView, ROOT_VIEW } from "./pane-model.js";

const VIEW_KEY = "clio-coder-gui-pane-view";
const OPEN_KEY = "clio-coder-gui-pane";
// The previous panel's keys. Read once so an existing preference survives the move.
const OLD_VIEW_KEY = "clio-coder-gui-session-panel-view";
const DOCK_QUERY = "(min-width: 1100px)";

function initialView(): PaneView {
	try {
		return migratedPaneView(localStorage.getItem(VIEW_KEY) ?? localStorage.getItem(OLD_VIEW_KEY));
	} catch {
		return ROOT_VIEW;
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

// The section the last show asked for, until the drill that holds it has shown it. The page that
// owns the pane hands it only the view, so the request is kept here beside it; one session page is
// mounted at a time, and any other navigation of the pane drops it.
let requestedSection: PaneSection | null = null;
const sectionListeners = new Set<() => void>();

function requestSection(section: PaneSection | null): void {
	if (requestedSection === section) return;
	requestedSection = section;
	for (const listener of sectionListeners) listener();
}

function subscribeSection(listener: () => void): () => void {
	sectionListeners.add(listener);
	return () => sectionListeners.delete(listener);
}

const settleSection = () => requestSection(null);

/** The section a show asked the pane to open at, and how its drill says it has been shown. */
export function usePaneSection(): { section: PaneSection | null; settle: () => void } {
	const section = useSyncExternalStore(subscribeSection, () => requestedSection);
	return { section, settle: settleSection };
}

export interface PaneState {
	readonly open: boolean;
	readonly view: PaneView;
	/**
	 * Open the pane on a view, or at a section of one. `trigger` is the id of the control to return
	 * focus to on close.
	 */
	show(target: PaneTarget, trigger: string): void;
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
	const storeView = useCallback((next: PaneView) => {
		setViewState(next);
		try {
			localStorage.setItem(VIEW_KEY, next);
		} catch {
			// The preference holds in this tab.
		}
	}, []);
	const setView = useCallback(
		(next: PaneView) => {
			requestSection(null);
			storeView(next);
		},
		[storeView],
	);
	const close = useCallback(() => {
		requestSection(null);
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
		(target: PaneTarget, trigger: string) => {
			const { view: next, section } = paneTargetParts(target);
			opener.current = trigger;
			requestSection(section);
			storeView(next);
			setOpen(true);
			rememberOpen(true);
		},
		[storeView],
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
