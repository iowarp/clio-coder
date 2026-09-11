import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";

export const navigation = [
	{ label: "Overview", path: "/", available: true },
	{ label: "Sessions", path: "/sessions", available: true },
	{ label: "Traces", path: "/traces", available: true },
	{ label: "Toolchain", path: "/toolchain", available: true },
	{ label: "Docs", path: "/docs", available: true },
	{ label: "Settings", path: "/settings", available: true },
	{ label: "Fleet", path: "/fleet", available: true },
	{ label: "Evidence", path: "/evidence", available: true },
	{ label: "Evals", path: "/evals", available: true },
	{ label: "Library", path: "/library", available: false },
	{ label: "System", path: "/system", available: false },
] as const;
export function Navigation({ close }: { close?: () => void }) {
	const location = useLocation();
	return (
		<nav aria-label="Main navigation">
			{navigation.map((item, index) =>
				item.available ? (
					<NavLink
						key={item.path}
						to={item.path}
						end={item.path === "/"}
						onClick={close}
						className={({ isActive }) =>
							isActive || (item.path === "/sessions" && location.pathname.startsWith("/workspaces/")) ? "active" : ""
						}
					>
						{item.label}
						<span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
					</NavLink>
				) : (
					<span className="nav-unavailable" key={item.path} aria-disabled="true" title="Not available yet">
						{item.label}
						<span aria-hidden="true">·</span>
					</span>
				),
			)}
		</nav>
	);
}
export function MobileNavigation() {
	const dialog = useRef<HTMLDialogElement>(null);
	return (
		<>
			<button
				className="menu-toggle"
				type="button"
				onClick={() => dialog.current?.showModal()}
				aria-label="Open navigation"
			>
				Menu
			</button>
			<dialog ref={dialog} className="navigation-dialog" aria-label="Navigation">
				<div className="toast-heading">
					<strong>Clio Coder</strong>
					<button type="button" onClick={() => dialog.current?.close()} aria-label="Close navigation">
						Close
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
			return localStorage.getItem("clio-coder-web-theme") === "dark" ? "dark" : "light";
		} catch {
			return "light";
		}
	});
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		try {
			localStorage.setItem("clio-coder-web-theme", theme);
		} catch {
			/* Theme remains available for this tab. */
		}
	}, [theme]);
	return (
		<button className="theme-toggle" type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
			{theme === "light" ? "Dark theme" : "Light theme"}
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
