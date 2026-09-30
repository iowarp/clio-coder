import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useId, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";
import { useShortcutLayer } from "../interaction/use-shortcut.js";
import { ArtifactInspector, type InspectorSelection, selectArtifactSession } from "./ArtifactInspector.js";
import { PanelTabs } from "./PanelTabs.js";
import { SessionPanel } from "./SessionPanel.js";
import { SESSION_PANEL_VIEWS, type SessionPanelView, selectSessionPanel } from "./session-panel-model.js";
import { WorkerGraph } from "./WorkerGraph.js";
import "./inspector-dock.css";

export const InspectorDock = memo(function InspectorDock({
	open,
	onClose,
	client,
	sessionId,
	workspaceRoot,
	view,
	onViewChange,
	onCloseSession,
	closing,
}: {
	open: boolean;
	onClose: () => void;
	client: Client;
	sessionId: string;
	workspaceRoot?: string | undefined;
	view: SessionPanelView;
	onViewChange: (view: SessionPanelView) => void;
	onCloseSession: () => void;
	closing: boolean;
}) {
	const tabId = useId();
	const [wide, setWide] = useState(() => typeof window === "undefined" || matchMedia("(min-width: 1200px)").matches);
	const [selection, setSelection] = useState<InspectorSelection>({ view: "files", selectedFile: null, filter: "" });
	const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		if (open) setVisited((previous) => (previous.has(view) ? previous : new Set([...previous, view])));
	}, [open, view]);
	const dialog = useRef<HTMLDialogElement>(null);
	const dock = useRef<HTMLElement>(null);
	const session = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: selectSessionPanel,
	}).data;
	useEffect(() => {
		const query = matchMedia("(min-width: 1200px)");
		const change = () => setWide(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	useShortcutLayer("dialog", open && !wide);
	useEffect(() => {
		const node = dock.current;
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
	useEffect(() => {
		const node = dialog.current;
		if (!open || !node || !session?.id) return;
		if (wide) node.show();
		else node.showModal();
		return () => node.close();
	}, [open, wide, session?.id]);
	const artifacts = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: selectArtifactSession,
	}).data;
	if (!session) return null;
	const content = (
		<div className="session-dock">
			<header className="session-dock__header">
				<div>
					<p className="eyebrow">Conversation workspace</p>
					<h2>Session panel</h2>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close session panel"
					title="Collapse session panel (Ctrl/⌘ Shift \)"
				>
					<Icon name="close" />
				</button>
			</header>
			<PanelTabs id={tabId} tabs={SESSION_PANEL_VIEWS} value={view} onChange={onViewChange} label="Session panel views" />
			<div className="session-dock__content">
				{(["session", "tools"] as const).map((group) => (
					<div
						key={group}
						id={`${tabId}-panel-${group}`}
						role="tabpanel"
						aria-labelledby={`${tabId}-${group}`}
						hidden={view !== group}
					>
						{visited.has(group) ? (
							<SessionPanel
								client={client}
								session={session}
								workspaceRoot={workspaceRoot}
								tools={group === "tools"}
								onCloseSession={onCloseSession}
								closing={closing}
							/>
						) : null}
					</div>
				))}
				<div id={`${tabId}-panel-agents`} role="tabpanel" aria-labelledby={`${tabId}-agents`} hidden={view !== "agents"}>
					{visited.has("agents") ? <WorkerGraph client={client} session={session} /> : null}
				</div>
				<div
					id={`${tabId}-panel-artifacts`}
					role="tabpanel"
					aria-labelledby={`${tabId}-artifacts`}
					hidden={view !== "artifacts"}
					className="session-dock__artifacts"
				>
					{visited.has("artifacts") && artifacts ? (
						<ArtifactInspector
							client={client}
							session={artifacts}
							workspaceRoot={workspaceRoot}
							onClose={onClose}
							selection={selection}
							onSelectionChange={setSelection}
						/>
					) : null}
				</div>
			</div>
		</div>
	);
	return (
		<aside
			className="inspector-dock"
			data-modal={!wide}
			role={wide ? "complementary" : "presentation"}
			aria-label={wide ? "Conversation session panel" : undefined}
			hidden={!open}
			ref={dock}
		>
			<dialog
				ref={dialog}
				className="inspector-dialog"
				role={wide ? "presentation" : undefined}
				aria-label={wide ? undefined : "Conversation session panel"}
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
