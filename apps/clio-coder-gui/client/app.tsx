import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
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
import { LEFT_SIDEBAR, RIGHT_SIDEBAR, Splitter } from "./design/Splitter.js";
import { appCommands, type PaletteTask } from "./interaction/commands.js";
import { useLayersActive, useShortcut } from "./interaction/use-shortcut.js";
import { useSetupStatus } from "./pages/target-onboarding.js";
import { ASIDE_DOCK_QUERY, toggleAside, useAsideExpanded } from "./shell/aside-state.js";
import { OpenWorkspaceDialog } from "./shell/OpenWorkspaceDialog.js";
import { type ShellApi, ShellContext } from "./shell/shell-context.js";
import { isHeld, isSettingsPath, sessionIdFromPath, taskRows } from "./shell/shell-model.js";
import { TaskSidebar } from "./shell/TaskSidebar.js";
import { rememberedWorkspace, rememberWorkspace, useTaskActions } from "./shell/tasks.js";
import { useApplyTheme } from "./shell/theme.js";
import { WindowTitlebar } from "./shell/WindowTitlebar.js";
import { launchedPath, openAppWindow, whenFocused } from "./shell/windows.js";
import type { WizardExit } from "./wizard/Wizard.js";
import type { WizardMode } from "./wizard/wizard-model.js";
import "./shell/shell.css";

// The setup wizard, its films and its styles load only when it opens.
const Wizard = lazy(() => import("./wizard/Wizard.js"));
const CommandPalette = lazy(() =>
	import("./interaction/CommandPalette.js").then((module) => ({ default: module.CommandPalette })),
);
const HelpDialog = lazy(() => import("./interaction/HelpDialog.js").then((module) => ({ default: module.HelpDialog })));

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

function useDocked(): boolean {
	const [docked, setDocked] = useState(() => typeof matchMedia === "function" && matchMedia(ASIDE_DOCK_QUERY).matches);
	useEffect(() => {
		const query = matchMedia(ASIDE_DOCK_QUERY);
		const change = () => setDocked(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	return docked;
}

export function App({ client }: { client: Client }) {
	useApplyTheme();
	const queries = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const phone = usePhone();
	const docked = useDocked();
	const asideExpanded = useAsideExpanded();
	const [asideSlot, setAsideSlot] = useState<HTMLElement | null>(null);
	const [connection, setConnection] = useState<ConnectionState>(client.token ? "Connecting…" : "Not connected");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [drawer, setDrawer] = useState(false);
	const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed();
	const notices = useNotices();
	const [search] = useSearchParams();
	const [firstRun, setFirstRun] = useState(false);
	// A dialog or the palette claims a keyboard layer. While one is claimed, the page behind it must
	// not be reachable by Tab either, or the focus order silently leaves the thing that has focus.
	const layered = useLayersActive();
	const refused = useTokenRejected() || (!client.token && lastTokenWasRefused());
	const meta = useQuery({
		queryKey: ["meta"],
		queryFn: () => client.call(routes.meta, emptyInput),
		refetchInterval: 15_000,
		enabled: !!client.token,
	});
	// The launcher brought one window forward and named a page; only that window goes there.
	const launched = useRef<(path: string) => void>(() => {});
	launched.current = (path) =>
		whenFocused(() => {
			if (path !== window.location.pathname) void navigate(path);
		});
	useEffect(() => {
		if (client.token) return subscribe(client, queries, setConnection, (path) => launched.current(path));
	}, [client, queries]);
	const setup = useSetupStatus(client, !!client.token && !refused);
	// A machine with no connection at all opens the wizard, full window. It stays until the wizard
	// itself finishes, because saving the connection makes the status "ready" before the last step.
	useEffect(() => {
		if (setup.data?.state === "unconfigured") setFirstRun(true);
	}, [setup.data?.state]);
	const wizardMode: WizardMode | null =
		location.pathname === "/setup" ? (search.get("target") ? "repair" : "add") : firstRun ? "first" : null;
	const leaveWizard = useCallback(
		(to: WizardExit) => {
			setFirstRun(false);
			const from = (location.state as { from?: unknown } | null)?.from;
			void navigate(to === "home" ? "/" : typeof from === "string" ? from : "/settings/targets", { replace: true });
		},
		[navigate, location.state],
	);

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
			if (candidate && known.has(candidate)) return candidate;
		return [...(workspaces.data ?? [])].sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0]?.id ?? null;
	}, [snapshot?.workspaceId, routeWorkspace, remembered, workspaces.data]);
	useEffect(() => {
		if (snapshot?.workspaceId) rememberWorkspace(snapshot.workspaceId);
	}, [snapshot?.workspaceId]);

	const closeDrawer = useCallback(() => setDrawer(false), []);
	// The phone drawer is modal: the page behind it goes inert, so focus has to move into it on open
	// or Escape has nowhere to land, and it returns to the control that opened it on close.
	const drawerOpener = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!phone) return;
		if (drawer) {
			const active = document.activeElement;
			drawerOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
			requestAnimationFrame(() =>
				document
					.getElementById(SIDEBAR_ID)
					?.querySelector<HTMLElement>("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])")
					?.focus(),
			);
			const dismiss = (event: KeyboardEvent) => {
				if (event.key === "Escape") setDrawer(false);
			};
			document.addEventListener("keydown", dismiss);
			return () => document.removeEventListener("keydown", dismiss);
		}
		const opener = drawerOpener.current;
		drawerOpener.current = null;
		// A navigation from the drawer hands focus to the new page; only a plain dismissal returns it.
		requestAnimationFrame(() => {
			const active = document.activeElement;
			const stranded = active === null || active === document.body || !!active.closest(`#${SIDEBAR_ID}`);
			if (stranded && opener?.isConnected) opener.focus();
		});
	}, [drawer, phone]);
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
	const openWindow = useCallback(
		() => openAppWindow(sessionId ? `/sessions/${sessionId}` : "/", client.token),
		[sessionId, client.token],
	);
	// Launching the installed app again focuses this window (`launch_handler` in the manifest) and
	// hands the launch here, so a launch that named a page still arrives at it.
	useEffect(() => {
		const queue = (window as { launchQueue?: { setConsumer(consumer: (launch: { targetURL?: string }) => void): void } })
			.launchQueue;
		queue?.setConsumer((launch) => {
			const path = launchedPath(launch.targetURL, window.location.origin, window.location.pathname);
			if (path !== null) void navigate(path);
		});
	}, [navigate]);

	useShortcut("palette", () => setPaletteOpen(true));
	useShortcut("newWindow", openWindow);
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
			if (sessions.some((session) => session.id === id && isHeld(session))) void navigate(`/sessions/${id}`);
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
					openWindow,
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
			openWindow,
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
			asideSlot: docked && mode === "work" ? asideSlot : null,
		}),
		[
			sidebarCollapsed,
			revealSidebar,
			startTask,
			openWorkspace,
			openHelp,
			activeWorkspaceId,
			actions.launch.busy,
			docked,
			mode,
			asideSlot,
		],
	);

	const pendingNotice = meta.data?.pendingVersion ? (
		<div className="app-update-notice" role="status">
			<strong>
				{meta.data.pendingVersion === meta.data.clio
					? `A different build of Clio Coder ${meta.data.clio} is installed. This app is still running the previous build.`
					: `Clio Coder ${meta.data.pendingVersion} is installed. This app is still running ${meta.data.clio}.`}
			</strong>
			<p>
				Finish active work, then run <code>clio-coder gui background restart --if-idle</code> and reload this window.
			</p>
		</div>
	) : null;
	const collapsed = sidebarCollapsed && !phone;
	const authed = !!client.token && !refused;
	if (wizardMode !== null && authed && meta.data?.apiVersion === API_VERSION)
		return (
			<>
				<WindowTitlebar />
				{pendingNotice}
				<Suspense
					fallback={
						<p className="route-error" role="status">
							Opening setup…
						</p>
					}
				>
					<Wizard
						key={wizardMode}
						client={client}
						mode={wizardMode}
						targetId={search.get("target") ?? undefined}
						onExit={leaveWizard}
					/>
				</Suspense>
				<LiveRegions />
				<NoticeToasts />
			</>
		);
	return (
		<div
			className="wb"
			data-sidebar={collapsed ? "collapsed" : "expanded"}
			data-drawer={drawer ? "open" : "closed"}
			data-aside={docked && mode === "work" && authed && asideExpanded ? "expanded" : "collapsed"}
			data-mode={mode}
		>
			<WindowTitlebar />
			<RouteFocus />
			<PwaBoot enabled={meta.data?.pwa ?? false} token={client.token} />
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<aside
				className="wb-sidebar"
				id={SIDEBAR_ID}
				aria-label="Clio navigation and settings"
				inert={layered || (phone && !drawer)}
				onKeyDown={(event) => {
					if (event.key === "Escape" && drawer) setDrawer(false);
				}}
			>
				{authed ? (
					<TaskSidebar
						client={client}
						version={meta.data?.clio}
						platform={meta.data?.platform}
						actions={actions}
						connection={connection}
						activeWorkspaceId={activeWorkspaceId}
						onOpenWorkspace={openWorkspace}
						onSearch={() => setPaletteOpen(true)}
						onToggle={revealSidebar}
						onNavigate={closeDrawer}
						onHelp={openHelp}
					/>
				) : null}
				{authed && !phone && !collapsed ? (
					<Splitter spec={LEFT_SIDEBAR} edge="end" label="Resize sidebar" host=".wb" onCollapse={toggleSidebar} />
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
					{pendingNotice}
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
			<Suspense fallback={null}>
				{paletteOpen ? <CommandPalette open commands={commands} onClose={() => setPaletteOpen(false)} /> : null}
				{helpOpen ? (
					<HelpDialog open onClose={() => setHelpOpen(false)} bundledDocsPath={meta.data?.bundledDocsPath} />
				) : null}
			</Suspense>
			{/* The right sidebar, the left rail's mirror in the same chrome. Pages portal into its body. */}
			{docked && mode === "work" && authed ? (
				<aside className="wb-aside" aria-label="This task and project" inert={layered} hidden={!asideExpanded}>
					<Splitter spec={RIGHT_SIDEBAR} edge="start" label="Resize right sidebar" host=".wb" onCollapse={toggleAside} />
					<div className="wb-aside__slot" ref={setAsideSlot} />
				</aside>
			) : null}
			<LiveRegions />
			<NoticeToasts />
		</div>
	);
}
