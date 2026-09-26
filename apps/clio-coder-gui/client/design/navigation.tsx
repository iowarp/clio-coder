import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { announce, composeTitle, useLiveState } from "../interaction/announcer.js";
import { formatKeybinding, KEYBINDINGS } from "../interaction/keybindings.js";
import { Icon } from "./icons.js";

/** `--paper` from client/design/tokens.css, light and dark. Keep these two in step with it. */
export const THEME_COLORS: Readonly<Record<"light" | "dark", string>> = {
	light: "#f3eee4",
	dark: "#000000",
};

/**
 * The everyday path is the first group: home and the conversations. Everything used to inspect a run
 * or configure the installation stays one click away in the second, quieter group.
 */
export const navigation = [
	{ label: "Overview", path: "/", icon: "overview", group: "work" },
	{ label: "Sessions", path: "/sessions", icon: "sessions", group: "work" },
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
const SIDEBAR_CHORD = formatKeybinding(KEYBINDINGS.sidebar);

/** Reachable in both states, so a collapsed rail can always be opened again. */
export function SidebarToggle({ collapsed, toggle }: { collapsed: boolean; toggle: () => void }) {
	const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
	return (
		<button
			type="button"
			className="sidebar-toggle"
			aria-label={label}
			aria-expanded={!collapsed}
			aria-controls={SIDEBAR_ID}
			aria-keyshortcuts="Control+\\ Meta+\\"
			data-tip={`${label} (${SIDEBAR_CHORD})`}
			onClick={toggle}
		>
			<Icon name="sidebar" />
			<span className="nav-label">{collapsed ? "Expand" : "Collapse"}</span>
			<kbd className="nav-label">{navigator.platform.startsWith("Mac") ? "⌘\\" : "Ctrl \\"}</kbd>
		</button>
	);
}

/**
 * Collapsed, the labels stay in the document for assistive technology and the icon carries the
 * link visually; `data-tip` shows the name on hover and on keyboard focus.
 */
export function Navigation({
	close,
	collapsed = false,
	onHelp,
	projects,
}: {
	close?: () => void;
	collapsed?: boolean;
	onHelp: () => void;
	projects?: ReactNode;
}) {
	const location = useLocation();
	const link = (item: (typeof navigation)[number]) => (
		<NavLink
			key={item.path}
			to={item.path}
			end={item.path === "/"}
			onClick={close}
			data-tip={collapsed ? item.label : undefined}
			data-group={item.group}
			className={({ isActive }) =>
				isActive || (item.path === "/sessions" && location.pathname.startsWith("/workspaces/")) ? "active" : ""
			}
		>
			<Icon name={item.icon} />
			<span className="nav-label">{item.label}</span>
		</NavLink>
	);
	return (
		<>
			<nav aria-label="Main navigation">{navigation.filter((item) => item.group === "work").map(link)}</nav>
			{projects}
			<nav aria-label="Inspection and settings">
				<p className="nav-group" aria-hidden="true">
					<span className="nav-label">Inspect &amp; configure</span>
				</p>
				{navigation.filter((item) => item.group === "more").map(link)}
			</nav>
			<button
				type="button"
				className="nav-help"
				aria-label="Help"
				data-tip={collapsed ? "Help (Ctrl /)" : undefined}
				onClick={() => {
					close?.();
					onHelp();
				}}
			>
				<Icon name="docs" />
				<span className="nav-label">Help</span>
			</button>
		</>
	);
}
export function MobileNavigation({
	onHelp,
	projects,
}: {
	onHelp: () => void;
	projects?: ((close: () => void) => ReactNode) | undefined;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const location = useLocation();
	const previousPath = useRef(location.pathname);
	useEffect(() => {
		if (previousPath.current !== location.pathname) dialog.current?.close();
		previousPath.current = location.pathname;
	}, [location.pathname]);
	return (
		<>
			<button
				className="icon-button menu-toggle"
				type="button"
				onClick={() => dialog.current?.showModal()}
				aria-label="Open navigation"
			>
				<Icon name="menu" />
			</button>
			<dialog ref={dialog} className="navigation-dialog" aria-label="Navigation">
				<div className="toast-heading">
					<strong className="brand">
						<img src="/clio-coder-logo.webp" alt="" width="32" height="32" />
						Clio Coder
					</strong>
					<button
						className="icon-button"
						type="button"
						onClick={() => dialog.current?.close()}
						aria-label="Close navigation"
					>
						<Icon name="close" />
					</button>
				</div>
				<Navigation
					close={() => dialog.current?.close()}
					onHelp={onHelp}
					projects={projects?.(() => dialog.current?.close())}
				/>
			</dialog>
		</>
	);
}
type Theme = "light" | "dark";
const THEME_KEY = "clio-coder-gui-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
function chosenTheme(): Theme | null {
	try {
		const saved = localStorage.getItem(THEME_KEY);
		return saved === "dark" || saved === "light" ? saved : null;
	} catch {
		return null;
	}
}
function systemTheme(): Theme {
	try {
		return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
	} catch {
		return "light";
	}
}
/**
 * An explicit choice persists and wins in both directions. Without one the page follows the system
 * preference as it changes, and nothing is saved: this toggle used to save whatever the system said
 * on the first visit, which froze that theme as if the operator had chosen it.
 */
export function ThemeToggle() {
	const [chosen, setChosen] = useState<Theme | null>(chosenTheme);
	const [system, setSystem] = useState<Theme>(systemTheme);
	useEffect(() => {
		if (chosen) return;
		const query = window.matchMedia(DARK_QUERY);
		const change = () => setSystem(query.matches ? "dark" : "light");
		query.addEventListener("change", change);
		return () => query.removeEventListener("change", change);
	}, [chosen]);
	const theme = chosen ?? system;
	useLayoutEffect(() => {
		// Without a choice the token layer's own media query paints the theme, so no attribute is set.
		if (chosen) document.documentElement.dataset.theme = chosen;
		else delete document.documentElement.dataset.theme;
		// The browser chrome must match the page ground exactly.
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
	}, [chosen, theme]);
	const choose = (next: Theme) => {
		setChosen(next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			/* The choice holds for this tab. */
		}
	};
	return (
		<button
			className="icon-button theme-toggle"
			type="button"
			aria-label={theme === "light" ? "Dark theme" : "Light theme"}
			title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
			onClick={() => choose(theme === "light" ? "dark" : "light")}
		>
			<Icon name={theme === "light" ? "moon" : "sun"} />
		</button>
	);
}
/**
 * The one writer of `document.title`. The route label and the approval marker compose in
 * `announcer.ts`, so a waiting approval is visible on a backgrounded tab without two effects
 * fighting over the same string.
 */
export function RouteFocus() {
	const location = useLocation(),
		previous = useRef(location.pathname);
	const { approvalPending } = useLiveState();
	useEffect(() => {
		if (previous.current !== location.pathname) document.getElementById("main")?.focus();
		previous.current = location.pathname;
	}, [location.pathname]);
	useEffect(() => {
		const section = navigation.find((item) => item.path !== "/" && location.pathname.startsWith(item.path));
		document.title = composeTitle(section?.label, approvalPending);
	}, [location.pathname, approvalPending]);
	return null;
}
