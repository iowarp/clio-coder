import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { API_VERSION } from "../contracts/meta.js";
import { routes } from "../contracts/routes.js";
import type { SessionSnapshot, SessionSummary } from "../contracts/sessions.js";
import { useTokenRejected } from "./api/auth-state.js";
import { type Client, emptyInput } from "./api/client.js";
import { type ConnectionState, subscribe } from "./api/events.js";
import { lastTokenWasRefused } from "./api/token.js";
import { Icon } from "./design/icons.js";
import { RouteFocus, SIDEBAR_ID, useSidebarCollapsed } from "./design/navigation.js";
import { dismissAll, LiveRegions, NoticeToasts, reportProblem, useNotices } from "./design/notifications.js";
import { PwaBoot } from "./design/pwa.js";
import { Reconnect } from "./design/reconnect.js";
import { CommandPalette } from "./interaction/CommandPalette.js";
import { appCommands, type PaletteTask } from "./interaction/commands.js";
import { HelpDialog } from "./interaction/HelpDialog.js";
import { useLayersActive, useShortcut } from "./interaction/use-shortcut.js";
import { OpenWorkspaceDialog } from "./shell/OpenWorkspaceDialog.js";
import { SettingsSidebar } from "./shell/SettingsSidebar.js";
import { type ShellApi, ShellContext } from "./shell/shell-context.js";
import { isSettingsPath, sessionIdFromPath, taskRows } from "./shell/shell-model.js";
import { TaskSidebar } from "./shell/TaskSidebar.js";
import { rememberedWorkspace, rememberWorkspace, useTaskActions } from "./shell/tasks.js";
import { useApplyTheme } from "./shell/theme.js";
import "./shell/shell.css";

const PHONE = "(max-width: 760px)";

function usePhone(): boolean {
	const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
	useEffect(() => {
		const query = matchMedia(PHONE);
		const change = () => setPhone(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	return phone;
}

export function App({ client }: { client: Client }) {
	useApplyTheme();
	const queries = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const phone = usePhone();
	const [connection, setConnection] = useState<ConnectionState>(client.token ? "Connecting…" : "Not connected");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [drawer, setDrawer] = useState(false);
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
		if (client.token) return subscribe(client, queries, setConnection);
	}, [client, queries]);

	const sessionId = sessionIdFromPath(location.pathname);
	const mode = isSettingsPath(location.pathname) ? "settings" : "work";
	// `enabled: false` reads the cache the conversation already filled and re-renders when it
	// changes, without this component ever fetching a session of its own.
	const session = useQuery({
		queryKey: ["session", sessionId ?? ""],
		queryFn: () => client.call(routes.session, { params: { id: sessionId ?? "" }, query: {}, body: {} }),
		select: (value) => ({
			workspaceId: value.workspaceId,
			state: value.state,
			runningTurnId: value.turns.at(-1)?.status === "running" ? (value.turns.at(-1)?.id ?? null) : null,
		}),
		enabled: false,
	});
	const snapshot = sessionId === null ? undefined : session.data;
	const runningTurnId = snapshot?.runningTurnId ?? null;

	const workspaces = useQuery({
		queryKey: ["workspaces"],
		queryFn: () => client.call(routes.workspaces, emptyInput),
		enabled: !!client.token,
	});
	const routeWorkspace = /^\/workspaces\/([^/]+)/.exec(location.pathname)?.[1];
	const [remembered] = useState(rememberedWorkspace);
	const activeWorkspaceId = useMemo(() => {
		const known = new Set(workspaces.data?.map((workspace) => workspace.id));
		for (const candidate of [snapshot?.workspaceId, routeWorkspace, remembered])
			if (candidate && (known.size === 0 || known.has(candidate))) return candidate;
		return [...(workspaces.data ?? [])].sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0]?.id ?? null;
	}, [snapshot?.workspaceId, routeWorkspace, remembered, workspaces.data]);
	useEffect(() => {
		if (snapshot?.workspaceId) rememberWorkspace(snapshot.workspaceId);
	}, [snapshot?.workspaceId]);

	// Settings has one way back: the last place the operator was working.
	const [backTo, setBackTo] = useState("/");
	useEffect(() => {
		if (mode === "work") setBackTo(`${location.pathname}${location.search}`);
	}, [mode, location.pathname, location.search]);

	const closeDrawer = useCallback(() => setDrawer(false), []);
	const actions = useTaskActions(client, closeDrawer);
	const previousPath = useRef(location.pathname);
	useEffect(() => {
		if (previousPath.current !== location.pathname) {
			setDrawer(false);
			setWorkspaceOpen(false);
		}
		previousPath.current = location.pathname;
	}, [location.pathname]);

	const revealSidebar = useCallback(() => {
		if (phone) setDrawer((open) => !open);
		else toggleSidebar();
	}, [phone, toggleSidebar]);
	const startTask = useCallback(() => {
		if (activeWorkspaceId) actions.newTask(activeWorkspaceId);
		else setWorkspaceOpen(true);
	}, [activeWorkspaceId, actions.newTask]);
	const openWorkspace = useCallback(() => setWorkspaceOpen(true), []);
	const openHelp = useCallback(() => setHelpOpen(true), []);

	useShortcut("palette", () => setPaletteOpen(true));
	useShortcut("help", openHelp);
	useShortcut("sidebar", revealSidebar);
	useShortcut("newTask", startTask);
	useShortcut("openWorkspace", openWorkspace);

	// The rail only loads the projects that are expanded, so opening the palette lists what is cached,
	// then fills in the other projects' saved tasks once (fresh results are reused for 30 seconds).
	const [paletteTasks, setPaletteTasks] = useState<readonly PaletteTask[]>([]);
	useEffect(() => {
		if (!paletteOpen) return;
		const collect = () => {
			const sessions = queries.getQueryData<SessionSnapshot[]>(["sessions"]) ?? [];
			return (workspaces.data ?? []).flatMap((workspace) =>
				taskRows(
					workspace.id,
					sessions,
					queries.getQueryData<SessionSummary[]>(["session-history", workspace.id]) ?? [],
				).map((row) => ({ id: row.id, title: row.title, project: workspace.name, open: row.open })),
			);
		};
		let current = true;
		setPaletteTasks(collect());
		void Promise.allSettled(
			(workspaces.data ?? []).map((workspace) =>
				queries.prefetchQuery({
					queryKey: ["session-history", workspace.id],
					queryFn: () => client.call(routes.sessionHistory, { params: { id: workspace.id }, query: {}, body: {} }),
					staleTime: 30_000,
				}),
			),
		).then(() => {
			if (current) setPaletteTasks(collect());
		});
		return () => {
			current = false;
		};
	}, [paletteOpen, workspaces.data, queries, client]);
	const openTask = useCallback(
		(id: string) => {
			const sessions = queries.getQueryData<SessionSnapshot[]>(["sessions"]) ?? [];
			if (sessions.some((session) => session.id === id && session.state !== "closed")) void navigate(`/sessions/${id}`);
			else {
				const workspace = (workspaces.data ?? []).find((candidate) =>
					queries.getQueryData<SessionSummary[]>(["session-history", candidate.id])?.some((row) => row.id === id),
				);
				if (workspace) actions.resume(id, workspace.id);
			}
		},
		[queries, navigate, workspaces.data, actions.resume],
	);
	const commands = useMemo(
		() =>
			appCommands(
				{
					sessionId,
					runningTurnId,
					sessionOpen: snapshot?.state === "open",
					hasNotices: notices.length > 0,
					tasks: paletteTasks,
				},
				{
					navigate: (path) => void navigate(path),
					openHelp,
					toggleSidebar: revealSidebar,
					dismissNotices: dismissAll,
					newTask: startTask,
					openWorkspace,
					openTask,
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
		[
			client,
			navigate,
			notices.length,
			queries,
			runningTurnId,
			sessionId,
			snapshot?.state,
			revealSidebar,
			startTask,
			openWorkspace,
			openHelp,
			paletteTasks,
			openTask,
		],
	);
	const shell = useMemo<ShellApi>(
		() => ({
			sidebarCollapsed,
			revealSidebar,
			startTask,
			openWorkspace,
			openHelp,
			activeWorkspaceId,
			starting: actions.launch.busy,
		}),
		[sidebarCollapsed, revealSidebar, startTask, openWorkspace, openHelp, activeWorkspaceId, actions.launch.busy],
	);

	const collapsed = sidebarCollapsed && !phone;
	const authed = !!client.token && !refused;
	return (
		<div
			className="wb"
			data-sidebar={collapsed ? "collapsed" : "expanded"}
			data-drawer={drawer ? "open" : "closed"}
			data-mode={mode}
		>
			<RouteFocus />
			<PwaBoot enabled={meta.data?.pwa ?? false} token={client.token} />
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<aside
				className="wb-sidebar"
				id={SIDEBAR_ID}
				aria-label="Tasks and settings"
				inert={layered || (phone && !drawer)}
				onKeyDown={(event) => {
					if (event.key === "Escape" && drawer) setDrawer(false);
				}}
			>
				{authed ? (
					mode === "settings" ? (
						<SettingsSidebar backTo={backTo} onNavigate={closeDrawer} onToggle={revealSidebar} onHelp={openHelp} />
					) : (
						<TaskSidebar
							client={client}
							actions={actions}
							connection={connection}
							activeWorkspaceId={activeWorkspaceId}
							onOpenWorkspace={openWorkspace}
							onSearch={() => setPaletteOpen(true)}
							onToggle={revealSidebar}
							onNavigate={closeDrawer}
						/>
					)
				) : null}
			</aside>
			<button type="button" className="wb-scrim" aria-label="Close sidebar" tabIndex={-1} onClick={closeDrawer} />
			<div className="wb-stage" data-mode={mode} inert={layered || (phone && drawer)}>
				<div className="wb-float">
					<button
						type="button"
						className="wb-icon"
						aria-label="Show sidebar"
						aria-controls={SIDEBAR_ID}
						onClick={revealSidebar}
					>
						<Icon name="sidebar" />
					</button>
				</div>
				<main id="main" className="wb-main" data-mode={mode} tabIndex={-1}>
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
						<ShellContext.Provider value={shell}>
							<Outlet context={connection} />
						</ShellContext.Provider>
					)}
				</main>
			</div>

			{workspaceOpen ? (
				<OpenWorkspaceDialog client={client} launch={actions.launch} onClose={() => setWorkspaceOpen(false)} />
			) : null}
			<CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
			<HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} bundledDocsPath={meta.data?.bundledDocsPath} />
			<LiveRegions />
			<NoticeToasts />
		</div>
	);
}
