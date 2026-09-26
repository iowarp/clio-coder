import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { API_VERSION } from "../contracts/meta.js";
import { routes } from "../contracts/routes.js";
import { useTokenRejected } from "./api/auth-state.js";
import { type Client, emptyInput } from "./api/client.js";
import { type ConnectionState, subscribe } from "./api/events.js";
import { lastTokenWasRefused } from "./api/token.js";
import { Icon } from "./design/icons.js";
import {
	MobileNavigation,
	Navigation,
	RouteFocus,
	SIDEBAR_ID,
	SidebarToggle,
	ThemeToggle,
	useSidebarCollapsed,
} from "./design/navigation.js";
import { AREA_LABELS, navigationArea } from "./design/navigation-area.js";
import { dismissAll, LiveRegions, NoticeToasts, reportProblem, useNotices } from "./design/notifications.js";
import { ProjectNavigation } from "./design/project-navigation.js";
import { AppPreferences } from "./design/pwa.js";
import { Reconnect } from "./design/reconnect.js";
import { CommandPalette } from "./interaction/CommandPalette.js";
import { appCommands } from "./interaction/commands.js";
import { HelpDialog } from "./interaction/HelpDialog.js";
import { useLayersActive, useShortcut } from "./interaction/use-shortcut.js";
import "./design/context-navigation.css";

const areaViews = {
	traces: lazy(() => import("./design/trace-navigation.js").then((module) => ({ default: module.TraceNavigation }))),
	fleet: lazy(() => import("./design/fleet-navigation.js").then((module) => ({ default: module.FleetNavigation }))),
	evidence: lazy(() =>
		import("./design/evidence-navigation.js").then((module) => ({ default: module.EvidenceNavigation })),
	),
	library: lazy(() =>
		import("./design/library-navigation.js").then((module) => ({ default: module.LibraryNavigation })),
	),
	toolchain: lazy(() =>
		import("./design/toolchain-navigation.js").then((module) => ({ default: module.ToolchainNavigation })),
	),
	settings: lazy(() =>
		import("./design/settings-navigation.js").then((module) => ({ default: module.SettingsNavigation })),
	),
	system: lazy(() => import("./design/system-navigation.js").then((module) => ({ default: module.SystemNavigation }))),
};

/** `/sessions/:id` and nothing else. The palette's session rows exist only on a conversation. */
function sessionIdFrom(pathname: string): string | null {
	const match = /^\/sessions\/([^/]+)$/.exec(pathname);
	return match?.[1] ?? null;
}

export function App({ client }: { client: Client }) {
	const queries = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const [navigationAt, setNavigationAt] = useState<string | null>(null);
	const previousPath = useRef(location.pathname);
	useEffect(() => {
		if (previousPath.current !== location.pathname) setNavigationAt(null);
		previousPath.current = location.pathname;
	}, [location.pathname]);
	const [connection, setConnection] = useState<ConnectionState>(client.token ? "Connecting…" : "Not connected");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed();
	const notices = useNotices();
	// A dialog or the palette claims a keyboard layer. While one is claimed, the page behind it must
	// not be reachable by Tab either, or the focus order silently leaves the thing that has focus.
	const layered = useLayersActive();
	const refused = useTokenRejected() || (!client.token && lastTokenWasRefused());
	const area = navigationArea(location.pathname);
	const showArea = !!client.token && !refused && area !== null && navigationAt !== location.pathname;
	const meta = useQuery({
		queryKey: ["meta"],
		queryFn: () => client.call(routes.meta, emptyInput),
		enabled: !!client.token,
	});
	useEffect(() => {
		if (client.token) return subscribe(client, queries, setConnection);
	}, [client, queries]);

	const sessionId = sessionIdFrom(location.pathname);
	// `enabled: false` reads the cache the conversation already filled and re-renders when it
	// changes, without this component ever fetching a session of its own.
	const session = useQuery({
		queryKey: ["session", sessionId ?? ""],
		queryFn: () => client.call(routes.session, { params: { id: sessionId ?? "" }, query: {}, body: {} }),
		enabled: false,
	});
	const snapshot = sessionId === null ? undefined : session.data;
	const lastTurn = snapshot?.turns.at(-1);
	const runningTurnId = lastTurn?.status === "running" ? lastTurn.id : null;

	useShortcut("palette", () => setPaletteOpen(true));
	useShortcut("help", () => setHelpOpen(true));
	useShortcut("sidebar", toggleSidebar);

	const commands = useMemo(
		() =>
			appCommands(
				{
					sessionId,
					runningTurnId,
					sessionOpen: snapshot?.state === "open",
					hasNotices: notices.length > 0,
				},
				{
					navigate: (path) => void navigate(path),
					openHelp: () => setHelpOpen(true),
					toggleSidebar,
					dismissNotices: dismissAll,
					cancelTurn: (turnId) => {
						if (sessionId === null) return;
						void client
							.call(routes.cancelTurn, { params: { id: sessionId, turnId }, query: {}, body: {} })
							.then(() => queries.invalidateQueries({ queryKey: ["session", sessionId] }))
							.catch(reportProblem);
					},
					closeSession: () => {
						if (sessionId === null) return;
						void client
							.call(routes.closeSession, { params: { id: sessionId }, query: {}, body: {} })
							.then(() => {
								void queries.invalidateQueries({ queryKey: ["session", sessionId] });
								void queries.invalidateQueries({ queryKey: ["sessions"] });
							})
							.catch(reportProblem);
					},
				},
			),
		[client, navigate, notices.length, queries, runningTurnId, sessionId, snapshot?.state, toggleSidebar],
	);
	const selectArea = (path: string) => {
		if (navigationArea(path)) {
			setNavigationAt(null);
			if (sidebarCollapsed) toggleSidebar();
			requestAnimationFrame(() => document.querySelector<HTMLElement>(".desktop-navigation .sidebar-back")?.focus());
		}
	};
	const navigationContent = (close?: () => void, collapsed = false) =>
		showArea && area && !collapsed ? (
			<>
				<div className="sidebar-area-actions">
					<button
						type="button"
						className="sidebar-back"
						onClick={(event) => {
							const container = event.currentTarget.closest(".sidebar, .navigation-dialog");
							setNavigationAt(location.pathname);
							requestAnimationFrame(() =>
								container?.querySelector<HTMLElement>('nav[aria-label="Main navigation"] a')?.focus(),
							);
						}}
					>
						<span aria-hidden="true">←</span> Navigation
					</button>
					<button
						type="button"
						className="sidebar-search"
						aria-label="Search commands"
						title="Search commands (Ctrl K)"
						onClick={() => {
							close?.();
							setPaletteOpen(true);
						}}
					>
						<Icon name="search" />
					</button>
					{!close ? <SidebarToggle collapsed={sidebarCollapsed} toggle={toggleSidebar} /> : null}
				</div>
				<h2 className="sidebar-area-title">{AREA_LABELS[area]}</h2>
				<Suspense
					fallback={
						<p className="sidebar-note" role="status">
							Loading {AREA_LABELS[area].toLocaleLowerCase()}…
						</p>
					}
				>
					{area === "sessions" ? (
						<ProjectNavigation client={client} activeWorkspace={snapshot?.workspaceId} close={close} />
					) : (
						(() => {
							const AreaView = areaViews[area];
							return <AreaView client={client} close={close} />;
						})()
					)}
				</Suspense>
			</>
		) : (
			<>
				{!close ? <SidebarToggle collapsed={sidebarCollapsed} toggle={toggleSidebar} /> : null}
				<Navigation collapsed={collapsed} close={close} onHelp={() => setHelpOpen(true)} onSelect={selectArea} />
			</>
		);

	return (
		<div className="shell">
			<RouteFocus />
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<header className="masthead">
				<NavLink to="/" className="brand">
					<img src="/clio-coder-logo.webp" alt="" width="36" height="36" />
					Clio Coder
				</NavLink>
				<div className="header-controls">
					<span className="connection" role="status" data-connected={connection === "Connected"} data-state={connection}>
						<span className="connection-dot" aria-hidden="true" />
						<span className="connection-label">{connection}</span>
					</span>
					<ThemeToggle />
					<AppPreferences
						enabled={meta.data?.pwa ?? false}
						token={client.token}
						version={meta.data?.clio}
						platform={meta.data?.platform}
					/>
					<MobileNavigation onHelp={() => setHelpOpen(true)} content={(close) => navigationContent(close)} />
				</div>
			</header>
			<div
				className="workspace"
				data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
				data-area={showArea && area ? area : "navigation"}
				inert={layered}
			>
				<aside className="desktop-navigation" id={SIDEBAR_ID}>
					<div className="sidebar">{navigationContent(undefined, sidebarCollapsed)}</div>
				</aside>
				<main id="main" tabIndex={-1}>
					{!client.token || refused ? (
						<Reconnect refused={refused} />
					) : meta.error ? (
						<div role="alert">
							<h1>Connection unavailable</h1>
							<p>{meta.error.message}</p>
							<button type="button" disabled={meta.isFetching} onClick={() => void meta.refetch()}>
								Try again
							</button>
						</div>
					) : meta.isPending ? (
						<p>Connecting to your installation…</p>
					) : meta.data.apiVersion !== API_VERSION ? (
						<div role="alert">The app and server versions differ. Rebuild the client and reload.</div>
					) : (
						<Outlet context={connection} />
					)}
				</main>
			</div>

			<CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
			<HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} bundledDocsPath={meta.data?.bundledDocsPath} />
			<LiveRegions />
			<NoticeToasts />
		</div>
	);
}
