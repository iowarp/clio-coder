import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { announce, composeTitle, useLiveState } from "../interaction/announcer.js";

/** `--paper` from client/design/tokens.css, light and dark. Keep these two in step with it. */
export const THEME_COLORS: Readonly<Record<"light" | "dark", string>> = {
	light: "#f6ede7",
	dark: "#0b0a09",
};

/**
 * The places Settings mode lists. The everyday path (tasks and the new-task screen) is the rail's
 * own and is not a destination here, so the document title and the palette never name it.
 */
export const navigation = [
	{ label: "Traces", path: "/traces", icon: "traces", group: "more" },
	{ label: "Fleet", path: "/fleet", icon: "fleet", group: "more" },
	{ label: "Evidence", path: "/evidence", icon: "evidence", group: "more" },
	{ label: "Library", path: "/library", icon: "library", group: "more" },
	{ label: "Toolchain", path: "/toolchain", icon: "toolchain", group: "more" },
	{ label: "Settings", path: "/settings", icon: "settings", group: "more" },
	{ label: "System", path: "/system", icon: "system", group: "more" },
] as const;
const SIDEBAR_KEY = "clio-coder-gui-sidebar";

/** The desktop sidebar's collapsed state. It is a per-browser preference, kept like the theme. */
export function useSidebarCollapsed(): readonly [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(() => {
		try {
			return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
		} catch {
			/* The choice holds for this tab. */
		}
	}, [collapsed]);
	const toggle = useCallback(() => setCollapsed((current) => !current), []);
	const first = useRef(true);
	useEffect(() => {
		// A keyboard chord has no visible focus change, so the new state is announced.
		if (first.current) first.current = false;
		else announce(collapsed ? "Sidebar collapsed" : "Sidebar expanded");
	}, [collapsed]);
	return [collapsed, toggle];
}

export const SIDEBAR_ID = "desktop-navigation";

/**
 * The one writer of `document.title`. The route label and the approval marker compose in
 * `announcer.ts`, so a waiting approval is visible on a backgrounded tab without two effects
 * fighting over the same string.
 */
export function RouteFocus() {
	const location = useLocation(),
		previous = useRef(location.pathname);
	const { approvalPending, pageTitle } = useLiveState();
	useEffect(() => {
		const changed = previous.current !== location.pathname;
		previous.current = location.pathname;
		if (!changed) return;
		// Let an outgoing modal release the workspace before focusing the destination.
		const frame = requestAnimationFrame(() => document.getElementById("main")?.focus());
		return () => cancelAnimationFrame(frame);
	}, [location.pathname]);
	useEffect(() => {
		const section = navigation.find((item) => location.pathname.startsWith(item.path));
		document.title = composeTitle(pageTitle ?? section?.label, approvalPending);
	}, [location.pathname, approvalPending, pageTitle]);
	return null;
}
