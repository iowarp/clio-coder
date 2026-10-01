import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";
import { useShortcutLayer } from "../interaction/use-shortcut.js";
import { Menu, MenuItem } from "../shell/Menu.js";
import { ArtifactInspector, type InspectorSelection } from "./ArtifactInspector.js";
import { ChangesView } from "./ChangesView.js";
import { changeCounts, NO_CHANGES, summarizeChanges } from "./changes-model.js";
import { ProgressView } from "./ProgressView.js";
import { PANE_VIEWS, type PaneView, selectPaneSession } from "./pane-model.js";
import { SessionPanel } from "./SessionPanel.js";
import { selectSessionPanel } from "./session-panel-model.js";
import { TerminalView } from "./TerminalView.js";
import { commandRuns } from "./terminal-model.js";
import { WorkerGraph } from "./WorkerGraph.js";
import "./pane.css";

const WIDTH_KEY = "clio-coder-gui-pane-width";
const MIN_WIDTH = 340;
const MAX_WIDTH = 800;

function storedWidth(): number | null {
	try {
		const value = Number(localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(value) && value >= MIN_WIDTH ? Math.min(value, MAX_WIDTH) : null;
	} catch {
		return null;
	}
}

/**
 * The pane beside the conversation. At 1100px and wider it docks and can be resized; narrower, the
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
	onCloseSession,
	closing,
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
	onCloseSession: () => void;
	closing: boolean;
}) {
	const tabId = useId();
	const aside = useRef<HTMLElement>(null);
	const dialog = useRef<HTMLDialogElement>(null);
	const [wide, setWide] = useState(() => typeof window === "undefined" || matchMedia("(min-width: 1100px)").matches);
	const [width, setWidth] = useState<number>(() => storedWidth() ?? 420);
	const [visited, setVisited] = useState<ReadonlySet<PaneView>>(() => new Set([view]));
	const [selection, setSelection] = useState<InspectorSelection>({ view: "files", selectedFile: null, filter: "" });
	useEffect(() => {
		if (open) setVisited((previous) => (previous.has(view) ? previous : new Set([...previous, view])));
	}, [open, view]);
	useEffect(() => {
		const query = matchMedia("(min-width: 1100px)");
		const change = () => setWide(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	useShortcutLayer("dialog", open && !wide);

	const pane = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: selectPaneSession,
	}).data;
	const legacy = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: selectSessionPanel,
	}).data;
	const files = useMemo(
		() =>
			pane === undefined
				? undefined
				: {
						id: pane.id,
						fleet: pane.fleet,
						timelineTruncated: pane.timelineTruncated,
						// The inspector lists newest first.
						tools: [...pane.tools].reverse(),
					},
		[pane],
	);
	const counts = useMemo(
		() => ({
			changes: pane ? summarizeChanges(pane.tools, workspaceRoot).files.length : 0,
			terminal: pane ? commandRuns(pane.tools, workspaceRoot).length : 0,
		}),
		[pane, workspaceRoot],
	);

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
		if (!open || !wide || !node) return;
		const dismissKey = (event: KeyboardEvent) => {
			if (matchesKeybinding(KEYBINDINGS.escape, event)) {
				event.stopPropagation();
				onClose();
			}
		};
		node.addEventListener("keydown", dismissKey);
		return () => node.removeEventListener("keydown", dismissKey);
	}, [open, wide, onClose]);

	// Width: a CSS variable on the conversation, so the grid column follows the drag with no re-render.
	useEffect(() => {
		const width = storedWidth();
		const host = aside.current?.closest<HTMLElement>(".conversation");
		if (width !== null && host) host.style.setProperty("--pane-w", `${width}px`);
	}, []);
	const resize = useCallback((next: number) => {
		const host = aside.current?.closest<HTMLElement>(".conversation");
		if (!host) return;
		const bound = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next), host.clientWidth * 0.62);
		host.style.setProperty("--pane-w", `${Math.round(bound)}px`);
		setWidth(Math.round(bound));
		try {
			localStorage.setItem(WIDTH_KEY, String(Math.round(bound)));
		} catch {
			// The width holds for this tab.
		}
	}, []);

	if (!pane) return null;
	const primary = PANE_VIEWS.filter((entry) => entry.primary);
	const extra = PANE_VIEWS.filter((entry) => !entry.primary);
	const activeExtra = extra.find((entry) => entry.id === view);
	const tabs = activeExtra ? [...primary, activeExtra] : primary;
	const badge = (id: PaneView): number => (id === "changes" ? counts.changes : id === "terminal" ? counts.terminal : 0);
	const mounted = (id: PaneView) => visited.has(id);
	const tab = (id: PaneView) => `${tabId}-${id}`;
	const content = (
		<div className="pane__inner">
			<header className="pane__head">
				<div className="pane__tabs" role="tablist" aria-label="Task views">
					{tabs.map((entry, index) => (
						<button
							key={entry.id}
							id={tab(entry.id)}
							type="button"
							role="tab"
							aria-selected={entry.id === view}
							aria-controls={`${tab(entry.id)}-panel`}
							tabIndex={entry.id === view ? 0 : -1}
							onClick={() => onViewChange(entry.id)}
							onKeyDown={(event) => {
								let next: number;
								if (matchesKeybinding(KEYBINDINGS.tabNext, event)) next = (index + 1) % tabs.length;
								else if (matchesKeybinding(KEYBINDINGS.tabPrevious, event)) next = (index + tabs.length - 1) % tabs.length;
								else if (matchesKeybinding(KEYBINDINGS.tabFirst, event)) next = 0;
								else if (matchesKeybinding(KEYBINDINGS.tabLast, event)) next = tabs.length - 1;
								else return;
								event.preventDefault();
								const target = tabs[next];
								if (!target) return;
								onViewChange(target.id);
								document.getElementById(tab(target.id))?.focus();
							}}
						>
							<span>{entry.label}</span>
							{badge(entry.id) > 0 ? <span className="pane__count">{badge(entry.id)}</span> : null}
						</button>
					))}
				</div>
				<Menu label="More views" icon="more">
					{extra.map((entry) => (
						<MenuItem key={entry.id} icon={entry.icon} onClick={() => onViewChange(entry.id)}>
							{entry.label}
						</MenuItem>
					))}
				</Menu>
				<button type="button" className="wb-icon" onClick={onClose} aria-label="Close pane" title="Close pane">
					<Icon name="close" />
				</button>
			</header>
			<div className="pane__body">
				{(
					[
						[
							"progress",
							<ProgressView
								key="p"
								client={client}
								session={pane}
								title={title}
								workspaceRoot={workspaceRoot}
								nowMs={nowMs}
								onOpen={onViewChange}
							/>,
						],
						["changes", <ChangesView key="c" session={pane} workspaceRoot={workspaceRoot} />],
						[
							"files",
							files ? (
								<ArtifactInspector
									key="f"
									bare
									client={client}
									session={files}
									workspaceRoot={workspaceRoot}
									onClose={onClose}
									selection={selection}
									onSelectionChange={setSelection}
								/>
							) : null,
						],
						["terminal", <TerminalView key="t" session={pane} workspaceRoot={workspaceRoot} />],
						["agents", legacy ? <WorkerGraph key="a" client={client} session={legacy} /> : null],
						[
							"session",
							legacy ? (
								<SessionPanel
									key="s"
									client={client}
									session={legacy}
									workspaceRoot={workspaceRoot}
									tools={false}
									onCloseSession={onCloseSession}
									closing={closing}
								/>
							) : null,
						],
						[
							"tools",
							legacy ? (
								<SessionPanel
									key="x"
									client={client}
									session={legacy}
									workspaceRoot={workspaceRoot}
									tools
									onCloseSession={onCloseSession}
									closing={closing}
								/>
							) : null,
						],
					] as const
				).map(([id, body]) => (
					<div
						key={id}
						id={`${tab(id)}-panel`}
						role="tabpanel"
						aria-labelledby={tab(id)}
						className="pane__panel"
						hidden={view !== id}
					>
						{mounted(id) ? body : null}
					</div>
				))}
			</div>
		</div>
	);
	return (
		<aside
			className="pane"
			data-modal={!wide}
			role={wide ? "complementary" : "presentation"}
			aria-label={wide ? "Task pane" : undefined}
			hidden={!open}
			ref={aside}
		>
			{wide ? (
				// biome-ignore lint/a11y/useSemanticElements: a separator that can be focused and moved is the window-splitter pattern.
				<div
					className="pane__grip"
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize pane"
					aria-valuemin={MIN_WIDTH}
					aria-valuemax={MAX_WIDTH}
					aria-valuenow={width}
					tabIndex={0}
					onPointerDown={(event) => {
						event.preventDefault();
						const grip = event.currentTarget;
						grip.setPointerCapture(event.pointerId);
						const move = (moved: PointerEvent) => {
							const host = aside.current?.closest<HTMLElement>(".conversation");
							if (host) resize(host.getBoundingClientRect().right - moved.clientX);
						};
						const stop = () => {
							grip.removeEventListener("pointermove", move);
							grip.removeEventListener("pointerup", stop);
							grip.removeEventListener("pointercancel", stop);
						};
						grip.addEventListener("pointermove", move);
						grip.addEventListener("pointerup", stop);
						grip.addEventListener("pointercancel", stop);
					}}
					onKeyDown={(event) => {
						if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
						event.preventDefault();
						const width = aside.current?.getBoundingClientRect().width ?? MIN_WIDTH;
						resize(width + (event.key === "ArrowLeft" ? 24 : -24));
					}}
				/>
			) : null}
			<dialog
				ref={dialog}
				open={wide && open}
				className="pane__dialog"
				role={wide ? "presentation" : undefined}
				aria-label={wide ? undefined : "Task pane"}
				onKeyDown={(event) => {
					if (matchesKeybinding(KEYBINDINGS.sessionPanel, event)) {
						event.preventDefault();
						onClose();
					}
				}}
				onCancel={(event) => {
					event.preventDefault();
					onClose();
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
	ids: { changes: string; terminal: string; pane: string };
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
	return (
		<>
			<button
				id={ids.changes}
				type="button"
				className="wb-icon wb-icon--text"
				aria-pressed={open && view === "changes"}
				aria-label={stat ? `Changes, ${stat}` : "Changes"}
				title="Changes"
				onClick={() => onToggle("changes", ids.changes)}
			>
				<Icon name="fileDiff" />
				{changes.files.length > 0 ? (
					<span className="diffstat" aria-hidden="true">
						<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
					</span>
				) : null}
			</button>
			<button
				id={ids.terminal}
				type="button"
				className="wb-icon"
				aria-pressed={open && view === "terminal"}
				aria-label="Terminal"
				title="Commands Clio ran"
				onClick={() => onToggle("terminal", ids.terminal)}
			>
				<Icon name="terminal" />
			</button>
			<button
				id={ids.pane}
				type="button"
				className="wb-icon"
				aria-pressed={open}
				aria-label={open ? "Hide pane" : "Show pane"}
				title="Task pane (Ctrl/⌘ Shift \\)"
				onClick={() => onToggle(view, ids.pane)}
			>
				<Icon name="panelRight" />
			</button>
		</>
	);
});
