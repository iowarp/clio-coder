import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { composeTitle, useLiveState } from "../interaction/announcer.js";
import { Icon } from "./icons.js";

/** `--paper` from client/design/tokens.css, light and dark. Keep these two in step with it. */
export const THEME_COLORS: Readonly<Record<"light" | "dark", string>> = {
	light: "#f2efe1",
	dark: "#18211c",
};

export const navigation = [
	{ label: "Overview", path: "/", icon: "overview" },
	{ label: "Sessions", path: "/sessions", icon: "sessions" },
	{ label: "Traces", path: "/traces", icon: "traces" },
	{ label: "Toolchain", path: "/toolchain", icon: "toolchain" },
	{ label: "Docs", path: "/docs", icon: "docs" },
	{ label: "Settings", path: "/settings", icon: "settings" },
	{ label: "Fleet", path: "/fleet", icon: "fleet" },
	{ label: "Evidence", path: "/evidence", icon: "evidence" },
	{ label: "Evals", path: "/evals", icon: "evals" },
	{ label: "Library", path: "/library", icon: "library" },
	{ label: "System", path: "/system", icon: "system" },
] as const;
export function Navigation({ close }: { close?: () => void }) {
	const location = useLocation();
	return (
		<nav aria-label="Main navigation">
			{navigation.map((item) => (
				<NavLink
					key={item.path}
					to={item.path}
					end={item.path === "/"}
					onClick={close}
					className={({ isActive }) =>
						isActive || (item.path === "/sessions" && location.pathname.startsWith("/workspaces/")) ? "active" : ""
					}
				>
					<Icon name={item.icon} />
					{item.label}
				</NavLink>
			))}
		</nav>
	);
}
export function MobileNavigation() {
	const dialog = useRef<HTMLDialogElement>(null);
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
				<Navigation close={() => dialog.current?.close()} />
			</dialog>
		</>
	);
}
export function ThemeToggle() {
	const [theme, setTheme] = useState<"light" | "dark">(() => {
		try {
			const saved = localStorage.getItem("clio-coder-gui-theme");
			return saved === "dark" || saved === "light"
				? saved
				: window.matchMedia("(prefers-color-scheme: dark)").matches
					? "dark"
					: "light";
		} catch {
			return "light";
		}
	});
	useLayoutEffect(() => {
		document.documentElement.dataset.theme = theme;
		// The browser chrome must match the page ground exactly. These are the `--paper` values the
		// token layer defines; the pair that used to be here predated the green palette and painted a
		// visible seam above the page.
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
		try {
			localStorage.setItem("clio-coder-gui-theme", theme);
		} catch {
			/* Theme remains available for this tab. */
		}
	}, [theme]);
	return (
		<button
			className="icon-button theme-toggle"
			type="button"
			aria-label={theme === "light" ? "Dark theme" : "Light theme"}
			title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
			onClick={() => setTheme(theme === "light" ? "dark" : "light")}
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
