import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { Icon } from "./icons.js";

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
			const saved = localStorage.getItem("clio-coder-web-theme");
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
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#202a25" : "#eee8d8");
		try {
			localStorage.setItem("clio-coder-web-theme", theme);
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
export function RouteFocus() {
	const location = useLocation(),
		previous = useRef(location.pathname);
	useEffect(() => {
		if (previous.current !== location.pathname) document.getElementById("main")?.focus();
		previous.current = location.pathname;
		const section = navigation.find((item) => item.path !== "/" && location.pathname.startsWith(item.path));
		document.title = section ? `${section.label} · Clio Coder` : "Clio Coder";
	}, [location.pathname]);
	return null;
}
