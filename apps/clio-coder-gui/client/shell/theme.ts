// The theme preference, shared by the one component that applies it (the shell) and the control
// that changes it (General settings). It used to live inside the masthead's toggle, which meant the
// theme applied only while that toggle was mounted.

import { useLayoutEffect, useSyncExternalStore } from "react";
import { THEME_COLORS } from "../design/navigation.js";

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

const THEME_KEY = "clio-coder-gui-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function readChoice(): ThemeChoice {
	try {
		const saved = localStorage.getItem(THEME_KEY);
		return saved === "dark" || saved === "light" ? saved : "system";
	} catch {
		return "system";
	}
}

let choice: ThemeChoice = readChoice();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	let query: MediaQueryList | undefined;
	try {
		query = window.matchMedia(DARK_QUERY);
		query.addEventListener("change", listener);
	} catch {
		// No media query support: the system preference reads as light.
	}
	return () => {
		listeners.delete(listener);
		query?.removeEventListener("change", listener);
	};
}

function systemTheme(): Theme {
	try {
		return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
	} catch {
		return "light";
	}
}

export function setThemeChoice(next: ThemeChoice): void {
	choice = next;
	try {
		// "system" stores nothing, so the token layer's own media query keeps painting the theme.
		if (next === "system") localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, next);
	} catch {
		// The choice holds for this tab.
	}
	for (const listener of listeners) listener();
}

const snapshot = () => `${choice}|${systemTheme()}`;

export function useTheme(): { choice: ThemeChoice; resolved: Theme } {
	const value = useSyncExternalStore(subscribe, snapshot, () => "system|light");
	const [chosen, resolved] = value.split("|") as [ThemeChoice, Theme];
	return { choice: chosen, resolved: chosen === "system" ? resolved : chosen };
}

/** Mounted once by the shell. An explicit choice wins in both directions; "system" sets no attribute. */
export function useApplyTheme(): void {
	const { choice: chosen, resolved } = useTheme();
	useLayoutEffect(() => {
		if (chosen === "system") delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = chosen;
		// The browser chrome must match the page ground exactly.
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
	}, [chosen, resolved]);
}
