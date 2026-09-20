import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { API_VERSION } from "../contracts/meta.js";
import { routes } from "../contracts/routes.js";
import { useTokenRejected } from "./api/auth-state.js";
import { type Client, emptyInput } from "./api/client.js";
import { subscribe } from "./api/events.js";
import { lastTokenWasRefused } from "./api/token.js";
import {
	MobileNavigation,
	Navigation,
	RouteFocus,
	SIDEBAR_ID,
	SidebarToggle,
	ThemeToggle,
	useSidebarCollapsed,
} from "./design/navigation.js";
import { dismissAll, LiveRegions, NoticeToasts, useNotices } from "./design/notifications.js";
import { AppPreferences } from "./design/pwa.js";
import { Reconnect } from "./design/reconnect.js";
import { CommandPalette } from "./interaction/CommandPalette.js";
import { appCommands } from "./interaction/commands.js";
import { HelpDialog } from "./interaction/HelpDialog.js";
import { useLayersActive, useShortcut } from "./interaction/use-shortcut.js";

/** `/sessions/:id` and nothing else. The palette's session rows exist only on a conversation. */
function sessionIdFrom(pathname: string): string | null {
	const match = /^\/sessions\/([^/]+)$/.exec(pathname);
	return match?.[1] ?? null;
}

export function App({ client }: { client: Client }) {
	const queries = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const [connection, setConnection] = useState(client.token ? "Connecting…" : "Not connected");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed();
	const notices = useNotices();
	// A dialog or the palette claims a keyboard layer. While one is claimed, the page behind it must
	// not be reachable by Tab either, or the focus order silently leaves the thing that has focus.
	const layered = useLayersActive();
	const refused = useTokenRejected() || (!client.token && lastTokenWasRefused());
	const meta = useQuery({
		queryKey: ["meta"],
		queryFn: () => client.call(routes.meta, emptyInput),
		enabled: !!client.token,
	});
	useEffect(() => {
		if (client.token) return subscribe(client.token, queries, setConnection);
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
						void client.call(routes.cancelTurn, {
							params: { id: sessionId, turnId },
							query: {},
							body: {},
						});
					},
					closeSession: () => {
						if (sessionId === null) return;
						void client
							.call(routes.closeSession, { params: { id: sessionId }, query: {}, body: {} })
							.then(() => queries.invalidateQueries({ queryKey: ["session", sessionId] }));
					},
				},
			),
		[client, navigate, notices.length, queries, runningTurnId, sessionId, snapshot?.state, toggleSidebar],
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
					<span className="connection" role="status" title={connection} data-connected={connection === "Connected"}>
						<span className="connection-dot" aria-hidden="true" />
						<span className="sr-only">{connection}</span>
					</span>
					<ThemeToggle />
					<AppPreferences enabled={meta.data?.pwa ?? false} token={client.token} version={meta.data?.clio} />
					<MobileNavigation />
				</div>
			</header>
			<div className="workspace" data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"} inert={layered}>
				<aside className="desktop-navigation" id={SIDEBAR_ID}>
					<div className="sidebar">
						<SidebarToggle collapsed={sidebarCollapsed} toggle={toggleSidebar} />
						<Navigation collapsed={sidebarCollapsed} />
					</div>
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
						<Outlet />
					)}
				</main>
			</div>

			<CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
			<HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
			<LiveRegions />
			<NoticeToasts />
		</div>
	);
}
