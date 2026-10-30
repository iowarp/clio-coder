import { useQuery } from "@tanstack/react-query";
import { Activity, lazy, memo, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { DeferredViewBoundary } from "../interaction/DeferredView.js";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";
import { useShortcutLayer } from "../interaction/use-shortcut.js";
import { countRender } from "../render/render-probe.js";
import { ASIDE_DOCK_QUERY } from "../shell/aside-state.js";
import { useShell } from "../shell/shell-context.js";
import { BranchPanel } from "./BranchPanel.js";
import { changeCounts, NO_CHANGES, summarizeChanges } from "./changes-model.js";
import { ExtensionsPanel } from "./ExtensionsPanel.js";
import { HandoffPanel } from "./HandoffPanel.js";
import {
	PANE_DESCRIPTIONS,
	PANE_GROUPS,
	PANE_VIEWS,
	type PaneView,
	paneGate,
	paneViewLabel,
	ROOT_VIEW,
	selectPaneSession,
} from "./pane-model.js";
import { usePaneSection } from "./pane-state.js";
import { openRoutePicker } from "./RoutePicker.js";
import type { RouteFacts } from "./route.js";
import { needsTrustReview } from "./session-facts-model.js";
import { selectSessionPanel } from "./session-panel-model.js";
import "./pane.css";
import "./pane-inspection.css";

// Opening a conversation needs the chat, not every inspector's rendering code.
const ArtifactsPanel = lazy(() => import("./ArtifactsPanel.js").then((view) => ({ default: view.ArtifactsPanel })));
const ChangesView = lazy(() => import("./ChangesView.js").then((view) => ({ default: view.ChangesView })));
const ContextPanel = lazy(() => import("./ContextPanel.js").then((view) => ({ default: view.ContextPanel })));
const SessionBoardPanel = lazy(() => import("./SessionBoard.js").then((view) => ({ default: view.SessionBoardPanel })));
const SessionOverview = lazy(() => import("./SessionOverview.js").then((view) => ({ default: view.SessionOverview })));
const UsagePanel = lazy(() => import("./UsagePanel.js").then((view) => ({ default: view.UsagePanel })));
const WorkerGraph = lazy(() => import("./WorkerGraph.js").then((view) => ({ default: view.WorkerGraph })));

/**
 * The pane beside the conversation. At 1440px and wider it docks and can be resized; narrower, the
 * same content opens as a modal slide-over so the conversation keeps its reading width.
 */
export const SessionPane = memo(function SessionPane({
	open,
	onClose,
	client,
	sessionId,
	title,
	workspaceRoot,
	nowMs,
	view,
	onViewChange,
	route,
}: {
	open: boolean;
	onClose: () => void;
	client: Client;
	sessionId: string;
	title: string;
	workspaceRoot: string | undefined;
	nowMs: number;
	view: PaneView;
	onViewChange: (view: PaneView) => void;
	/** The next turn's route as the composer shows it, so both read the same facts. */
	route?: RouteFacts;
}) {
	countRender("session-pane");
	const headId = useId();
	const navigate = useNavigate();
	const requested = usePaneSection();
	const aside = useRef<HTMLElement>(null);
	const slot = useShell()?.asideSlot ?? null;
	const dialog = useRef<HTMLDialogElement>(null);
	const [wide, setWide] = useState(() => typeof window === "undefined" || matchMedia(ASIDE_DOCK_QUERY).matches);
	const [visited, setVisited] = useState(() => ({ sessionId, views: new Set<PaneView>(open ? [view] : []) }));
	useEffect(() => {
		setVisited((previous) => {
			if (previous.sessionId !== sessionId) return { sessionId, views: new Set<PaneView>(open ? [view] : []) };
			return !open || previous.views.has(view) ? previous : { sessionId, views: new Set([...previous.views, view]) };
		});
	}, [open, view, sessionId]);
	useEffect(() => {
		const query = matchMedia(ASIDE_DOCK_QUERY);
		const change = () => setWide(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	useShortcutLayer("dialog", open && !wide);
	// A drill-in hides the button that opened it, so focus moves to the view's title and Escape keeps
	// reaching the pane. The first render leaves focus alone; only a change of view moves it.
	const shownView = useRef(view);
	useEffect(() => {
		if (shownView.current === view) return;
		shownView.current = view;
		if (open) {
			document.getElementById(`${headId}-title`)?.focus();
			aside.current?.querySelector(".pane__body")?.scrollTo({ top: 0 });
		}
	}, [open, view, headId]);

	const pane = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: selectPaneSession,
	}).data;
	const capabilities = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: open && pane?.state === "open",
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const legacy = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: selectSessionPanel,
	}).data;
	// Only the slide-over is modal. The docked pane renders its dialog already open, because
	// `show()` would move focus into it on every page load.
	useEffect(() => {
		const node = dialog.current;
		if (!open || wide || !node || !pane?.id) return;
		node.showModal();
		return () => node.close();
	}, [open, wide, pane?.id]);
	useEffect(() => {
		const node = aside.current;
		if (!open || !wide || !slot || !node) return;
		const dismissKey = (event: KeyboardEvent) => {
			if (matchesKeybinding(KEYBINDINGS.escape, event)) {
				event.stopPropagation();
				// A drill-in steps back to the Session column first; only the column closes the pane.
				if (view !== ROOT_VIEW) onViewChange(ROOT_VIEW);
				else onClose();
			}
		};
		node.addEventListener("keydown", dismissKey);
		return () => node.removeEventListener("keydown", dismissKey);
	}, [open, wide, slot, onClose, view, onViewChange]);

	if (!pane) return null;
	// The picker belongs to the composer. On a narrow screen this pane covers the composer, so it steps
	// aside first; a task whose composer offers no picker is sent to the saved route instead.
	const changeModel = () => {
		if (!wide) onClose();
		requestAnimationFrame(() => {
			if (!openRoutePicker(sessionId)) void navigate("/settings/models");
		});
	};
	const drilled = view !== ROOT_VIEW;
	const mounted = (id: PaneView) => (open && view === id) || (visited.sessionId === sessionId && visited.views.has(id));
	const body = (id: PaneView) => {
		const gate = paneGate(id, pane.state === "open", capabilities.data);
		if (gate !== "ready")
			return (
				<div className="pane-inspection-empty">
					<Icon name={gate === "checking" ? "layers" : "unverified"} />
					<h3>
						{gate === "checking"
							? capabilities.error
								? "Task capabilities unavailable"
								: "Checking this connection"
							: gate === "closed"
								? "This task is closed"
								: `${paneViewLabel(id)} is unavailable`}
					</h3>
					<p>
						{gate === "checking"
							? capabilities.error
								? "Retry the capability read to find out which views this connection supports."
								: "Reading the capabilities reported by this task before requesting its data."
							: gate === "closed"
								? "Live details require an open task. Recorded progress and file changes remain in the overview."
								: id === "artifacts"
									? "This connection does not expose saved artifacts. You can still review file edits and paths reported in the conversation."
									: "This connection has not announced support for this view. Return to the task overview to inspect the facts it reports."}
					</p>
					{gate !== "checking" || capabilities.error ? (
						<button type="button" onClick={() => onViewChange(id === "artifacts" ? "changes" : ROOT_VIEW)}>
							{id === "artifacts" ? "Review file changes" : "Return to overview"}
						</button>
					) : (
						<p role="status">Checking available views…</p>
					)}
				</div>
			);
		switch (id) {
			case "handoff":
				return (
					<div className="pane-drill">
						<HandoffPanel
							client={client}
							sessionId={pane.id}
							sessionOpen={open && pane.state === "open" && view === id}
							capabilities={capabilities.data}
							running={pane.turns.at(-1)?.status === "running"}
						/>
					</div>
				);
			case "extensions":
				return (
					<div className="pane-drill">
						<ExtensionsPanel
							client={client}
							sessionId={pane.id}
							sessionOpen={open && pane.state === "open" && view === id}
							capabilities={capabilities.data}
							running={pane.turns.at(-1)?.status === "running"}
						/>
					</div>
				);
			case "session":
				return (
					<SessionOverview
						active={open && view === "session"}
						client={client}
						session={pane}
						title={title}
						workspaceRoot={workspaceRoot}
						nowMs={nowMs}
						onOpen={onViewChange}
						onChangeModel={changeModel}
						{...(route ? { route } : {})}
					/>
				);
			case "branches":
				return (
					<div className="pane-drill">
						<BranchPanel
							client={client}
							sessionId={pane.id}
							sessionOpen={pane.state === "open"}
							capabilities={capabilities.data}
							settledTurns={pane.turns.filter((turn) => turn.status !== "running").length}
							running={pane.turns.at(-1)?.status === "running"}
						/>
					</div>
				);
			case "artifacts":
				return (
					<ArtifactsPanel
						key={pane.id}
						client={client}
						sessionId={pane.id}
						open={open && pane.state === "open" && view === "artifacts"}
						capabilities={capabilities.data}
						settled={pane.turns.filter((turn) => turn.status !== "running").length}
					/>
				);
			case "changes":
				return <ChangesView session={pane} workspaceRoot={workspaceRoot} />;
			case "agents":
				return legacy ? <WorkerGraph client={client} session={legacy} /> : null;
			case "context":
			case "usage":
			case "board": {
				if (!legacy) return null;
				const facts = {
					client,
					sessionId: pane.id,
					sessionOpen: pane.state === "open",
					capabilities: capabilities.data,
					settledTurns: pane.turns.filter((turn) => turn.status !== "running").length,
				};
				if (id === "context")
					return (
						<ContextPanel
							{...facts}
							nowMs={nowMs}
							running={pane.turns.at(-1)?.status === "running"}
							{...(pane.telemetry?.workspace ? { workspace: pane.telemetry.workspace } : {})}
						/>
					);
				if (id === "usage")
					return (
						<UsagePanel
							{...facts}
							costDisplay={pane.costDisplay}
							{...((pane.state !== "open" || pane.turns.at(-1)?.status === "running") && pane.telemetry?.usage
								? { liveUsage: pane.telemetry.usage }
								: {})}
						/>
					);
				return (
					<SessionBoardPanel
						{...facts}
						running={pane.turns.at(-1)?.status === "running"}
						section={view === "board" ? requested.section : null}
						onSectionShown={requested.settle}
					/>
				);
			}
		}
	};
	const content = (
		<div className="pane__inner">
			<header className="pane__head" data-drilled={drilled}>
				{drilled ? (
					<button
						type="button"
						className="wb-icon wb-icon--text"
						onClick={() => onViewChange(ROOT_VIEW)}
						aria-label="Back to task details"
						title="Back to task details (Esc)"
					>
						<Icon name="arrowLeft" />
						<span>Back</span>
					</button>
				) : null}
				<h2 className="pane__title" id={`${headId}-title`} tabIndex={-1}>
					<Icon name={PANE_VIEWS.find((entry) => entry.id === view)?.icon ?? "sessions"} />
					{view === ROOT_VIEW ? "Task details" : view === "artifacts" ? "Task files" : paneViewLabel(view)}
				</h2>
				<button
					type="button"
					className="wb-icon"
					onClick={onClose}
					aria-label="Close task details"
					title="Close task details"
				>
					<Icon name={wide ? "panelRight" : "close"} />
				</button>
			</header>
			<label className="pane-inspection-switcher">
				<span>Inspect</span>
				<select aria-label="Inspect task" value={view} onChange={(event) => onViewChange(event.target.value as PaneView)}>
					{PANE_GROUPS.map((group) => (
						<optgroup key={group.label} label={group.label}>
							{group.views.map((id) => (
								<option key={id} value={id}>
									{id === ROOT_VIEW ? "Task overview" : id === "artifacts" ? "Task files" : paneViewLabel(id)}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</label>
			<p className="pane-inspection-description">{PANE_DESCRIPTIONS[view]}</p>
			{capabilities.error && (
				<div className="pane-inspection-error" role="alert">
					<p>{capabilities.error.message}</p>
					<button
						type="button"
						disabled={capabilities.isFetching}
						onClick={() => {
							void capabilities.refetch();
						}}
					>
						Retry connection details
					</button>
				</div>
			)}
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the body scrolls, so keyboard users must reach it even when a view holds no control. */}
			<section className="pane__body" aria-label="Task details content" tabIndex={0}>
				{PANE_VIEWS.map(({ id }) => (
					<Activity key={`${sessionId}-${id}`} mode={open && view === id ? "visible" : "hidden"}>
						<section className="pane__panel" aria-labelledby={`${headId}-title`}>
							<Suspense
								fallback={
									<p className="pane-inspection-description" role="status">
										Loading {paneViewLabel(id).toLocaleLowerCase()}…
									</p>
								}
							>
								<DeferredViewBoundary>{mounted(id) ? body(id) : null}</DeferredViewBoundary>
							</Suspense>
						</section>
					</Activity>
				))}
			</section>
		</div>
	);
	if (wide) {
		// Docked, the pane is the shell's right sidebar. Until the shell's column exists there is
		// nothing to draw, and never a modal.
		if (!slot) return null;
		return createPortal(
			<aside className="pane" aria-label="Task details" hidden={!open} ref={aside}>
				{content}
			</aside>,
			slot,
		);
	}
	return (
		<aside className="pane" data-modal="true" role="presentation" hidden={!open} ref={aside}>
			<dialog
				ref={dialog}
				className="pane__dialog"
				aria-label="Task pane"
				onKeyDown={(event) => {
					if (matchesKeybinding(KEYBINDINGS.sessionPanel, event)) {
						event.preventDefault();
						onClose();
					}
				}}
				onCancel={(event) => {
					event.preventDefault();
					// The slide-over steps back from a drill-in first, as the docked pane does.
					if (view !== ROOT_VIEW) onViewChange(ROOT_VIEW);
					else onClose();
				}}
			>
				{content}
			</dialog>
		</aside>
	);
});

/** The three controls at the right of the top bar. The Changes one carries the task's diffstat. */
export const PaneToggles = memo(function PaneToggles({
	client,
	sessionId,
	workspaceRoot,
	open,
	view,
	ids,
	onToggle,
}: {
	client: Client;
	sessionId: string;
	workspaceRoot: string | undefined;
	open: boolean;
	view: PaneView;
	ids: { changes: string; pane: string };
	onToggle: (view: PaneView, trigger: string) => void;
}) {
	const pane = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: selectPaneSession,
	}).data;
	const changes = useMemo(
		() => (pane ? summarizeChanges(pane.tools, workspaceRoot) : NO_CHANGES),
		[pane, workspaceRoot],
	);
	const stat = changeCounts(changes);
	const trustAttention = needsTrustReview(pane?.telemetry?.trust);
	return (
		<>
			<button
				id={ids.changes}
				type="button"
				className="wb-icon wb-icon--text"
				aria-pressed={open && view === "changes"}
				aria-label={stat ? `Review changes, ${stat}` : "Review changes"}
				title="Review changes"
				onClick={() => onToggle("changes", ids.changes)}
			>
				<Icon name="fileDiff" />
				<span>Review</span>
				{changes.applied > 0 ? (
					<span className="diffstat" aria-hidden="true">
						<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
					</span>
				) : null}
			</button>
			<button
				id={ids.pane}
				type="button"
				className="wb-icon wb-icon--text"
				aria-expanded={open}
				aria-label={`${open ? "Hide" : "Show"} task details${trustAttention ? ", project files need review" : ""}`}
				title="Task details (Ctrl/⌘ Shift \\)"
				onClick={() => onToggle(view, ids.pane)}
			>
				<Icon name="panelRight" />
				<span>Details</span>
				{trustAttention ? (
					<span className="pane-attention" aria-hidden="true">
						•
					</span>
				) : null}
			</button>
		</>
	);
});
