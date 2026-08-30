import { useEffect, useId, useRef, useState } from "react";
import type { Dispatch, FormEvent, KeyboardEvent, ReactNode } from "react";
import { AUTONOMY_LEVELS, THINKING_LEVELS } from "./protocol.ts";
import type {
	WireAutonomyLevel,
	WireClioPhase,
	WireDeleteChallenge,
	WireEventSource,
	WirePendingPermission,
	WireProjectSummary,
	WireSessionSummary,
	WireSettingsPatch,
	WireTarget,
	WireTimelineItem,
	WireTreeNode,
} from "./protocol.ts";
import { type AppAction, type AppState, formatProjectPath, isPromptBlocked, type OpenWorkspaceState } from "./state.ts";

export interface WorkbenchActions {
	browseProjects(path?: string): void;
	openProject(path: string): void;
	selectProject(projectId: string): void;
	forgetProject(projectId: string): void;
	refreshTree(projectId: string, directory?: readonly string[]): void;
	createNode(projectId: string, parent: readonly string[], name: string, kind: "file" | "folder"): void;
	moveNode(
		projectId: string,
		source: readonly string[],
		destination: { parent: readonly string[]; name: string },
		expectedNodeVersion?: string,
	): void;
	prepareDelete(projectId: string, target: readonly string[], expectedNodeVersion?: string): void;
	confirmDelete(projectId: string, confirmationId: string): void;
	newSession(projectId: string): void;
	loadSession(projectId: string, sessionId: string): void;
	closeSession(projectId: string): void;
	listSessions(projectId: string): void;
	labelSession(projectId: string, sessionId: string, label: string): void;
	deleteSession(projectId: string, sessionId: string): void;
	startTurn(projectId: string, prompt: string): void;
	cancelTurn(projectId: string, turnId: string): void;
	resolvePermission(projectId: string, turnId: string, permissionId: string, decision: "allow-once" | "reject"): void;
	getSettings(projectId: string): void;
	patchSettings(projectId: string, patch: WireSettingsPatch): void;
	listTargets(projectId: string): void;
	probeTarget(projectId: string, targetId: string): void;
	setAutonomy(projectId: string, level: WireAutonomyLevel): void;
}

interface WorkbenchViewProps {
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
}

type FileDialog = "create-file" | "create-folder" | "move" | "delete" | null;

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const NON_BLANK_PATTERN = String.raw`.*\S.*`;

function focusableWithin(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) =>
		!element.hidden && element.getAttribute("aria-hidden") !== "true"
	);
}

function containTabKey(event: globalThis.KeyboardEvent, container: HTMLElement): void {
	if (event.key !== "Tab") return;
	const focusable = focusableWithin(container);
	if (focusable.length === 0) {
		event.preventDefault();
		container.focus();
		return;
	}
	const first = focusable[0];
	const last = focusable.at(-1);
	if (!first || !last) return;
	if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
		event.preventDefault();
		first.focus();
	}
}

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(false);
	useEffect(() => {
		const media = globalThis.matchMedia(query);
		const update = () => setMatches(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, [query]);
	return matches;
}

/** Ticks once a second while a turn runs so the operator sees work progressing. */
function useElapsedSeconds(startedAt: string | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [startedAt]);
	if (startedAt === null) return 0;
	const started = Date.parse(startedAt);
	if (Number.isNaN(started)) return 0;
	return Math.max(0, Math.floor((now - started) / 1_000));
}

/** A single shared clock so many cards can show elapsed time without many timers. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const PHASE_PRESENTATION: Record<WireClioPhase, { label: string; tone: string }> = {
	starting: { label: "Starting Clio", tone: "info" },
	unbound: { label: "No session", tone: "info" },
	idle: { label: "Idle", tone: "success" },
	running: { label: "Running", tone: "action" },
	"awaiting-approval": { label: "Awaiting approval", tone: "warning" },
	cancelling: { label: "Stopping", tone: "warning" },
	failed: { label: "Failed", tone: "error" },
	closed: { label: "Closed", tone: "info" },
};

const SOURCE_LABELS: Record<WireEventSource, string> = {
	"reported-by-clio": "Reported by Clio",
	"observed-on-acp": "Observed on ACP",
	"observed-by-workbench": "Observed by Workbench",
	"replayed-from-clio": "Replayed from Clio",
};

const SOURCE_GUIDANCE: Record<WireEventSource, { label: string; description: string }> = {
	"reported-by-clio": {
		label: "Clio reported",
		description: "Clio supplied this fact; Workbench did not measure it independently.",
	},
	"observed-on-acp": {
		label: "Observed live",
		description: "Workbench received this event on Clio's live control channel.",
	},
	"observed-by-workbench": {
		label: "Observed locally",
		description: "Workbench observed this fact in its own project or process boundary.",
	},
	"replayed-from-clio": {
		label: "Earlier record",
		description: "Clio replayed this from an earlier turn in the same session.",
	},
};

const SETTING_GUIDANCE: Record<string, { label: string; description: string; scope: string | null }> = {
	"orchestrator.target": {
		label: "Clio target",
		description: "The configured service or runtime Clio will route the next turn through.",
		scope: "NEXT TURN",
	},
	"orchestrator.model": {
		label: "Model",
		description: "The model Clio will ask to work on the next turn.",
		scope: "NEXT TURN",
	},
	"orchestrator.thinkingLevel": {
		label: "Reasoning effort",
		description: "Clio's configured reasoning depth. Workbench does not infer what the bound session already uses.",
		scope: null,
	},
	autonomy: {
		label: "Default working freedom",
		description: "The autonomy level a newly created session will inherit. Change this session in the status bar.",
		scope: "NEXT SESSION",
	},
};

const AUTONOMY_LABELS: Record<WireAutonomyLevel, string> = {
	"read-only": "read only",
	suggest: "suggest",
	"auto-edit": "auto edit",
	"full-auto": "full auto",
};

function isAutonomyLevel(value: string): value is WireAutonomyLevel {
	return (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

function settingsPatch(key: string, value: string): WireSettingsPatch | null {
	if (key === "orchestrator.target" || key === "orchestrator.model") {
		return { [key]: value.length === 0 ? null : value };
	}
	if (key === "orchestrator.thinkingLevel" && (THINKING_LEVELS as readonly string[]).includes(value)) {
		return { "orchestrator.thinkingLevel": value as (typeof THINKING_LEVELS)[number] };
	}
	if (key === "autonomy" && isAutonomyLevel(value)) return { autonomy: value };
	return null;
}

const SESSION_STATE_LABELS: Record<WireSessionSummary["state"], string> = {
	open: "open",
	closed: "closed",
	unknown: "unknown",
};

const UNKNOWN_SESSION_NOTE = "Clio cannot tell whether another process still holds this session.";

function formatTimestamp(value: string): string {
	const timestamp = new Date(value);
	return Number.isNaN(timestamp.getTime())
		? "unavailable"
		: timestamp.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function Glyph({ children }: { children: ReactNode }) {
	return <span aria-hidden="true">{children}</span>;
}

function StatusMark({ tone = "neutral", label }: { tone?: string; label: string }) {
	return (
		<span className={`status-mark status-mark--${tone}`}>
			<span className="status-mark__dot" aria-hidden="true" />
			{label}
		</span>
	);
}

function BrandLockup({ compact = false }: { compact?: boolean }) {
	return (
		<div className={`brand-lockup${compact ? " brand-lockup--compact" : ""}`}>
			<div className="brand-lockup__mark">
				<img src="/assets/clio-coder-logo-128.webp" width="40" height="40" alt="" />
			</div>
			<div>
				<div className="brand-lockup__eyebrow">IOWARP · CLIO</div>
				<div className="brand-lockup__name">Workbench</div>
			</div>
		</div>
	);
}

function LoadingScreen() {
	return (
		<main className="boot-screen" id="conversation" aria-busy="true">
			<div className="boot-screen__instrument" aria-hidden="true">
				<span />
				<span />
				<span />
			</div>
			<BrandLockup />
			<p>Starting the localhost instrument…</p>
			<div className="boot-screen__rule" />
			<small>Workbench talks to one Clio process and never edits Clio configuration behind your back.</small>
		</main>
	);
}

function FailureScreen({ message }: { message: string }) {
	return (
		<main className="boot-screen boot-screen--failed" id="conversation">
			<BrandLockup />
			<div role="alert">
				<p className="kicker">LOCALHOST STARTUP FAILED</p>
				<h1>Workbench could not establish its local control channel.</h1>
				<pre>{message}</pre>
			</div>
			<button type="button" className="button button--primary" onClick={() => location.reload()}>
				Retry bootstrap
			</button>
		</main>
	);
}

function PanelHeading({ eyebrow, title, headingId, action }: {
	eyebrow: string;
	title: string;
	headingId?: string;
	action?: ReactNode;
}) {
	return (
		<div className="panel-heading">
			<div>
				<div className="panel-heading__eyebrow">{eyebrow}</div>
				<h2 id={headingId}>{title}</h2>
			</div>
			{action}
		</div>
	);
}

function pathKey(path: Readonly<{ segments: readonly string[] }> | readonly string[]): string {
	const segments = "segments" in path ? path.segments : path;
	return segments.join("");
}

function parentPath(path: readonly string[]): readonly string[] {
	return path.slice(0, -1);
}

function TreeBranch({
	nodes,
	selected,
	onSelect,
	level = 1,
}: {
	nodes: readonly WireTreeNode[];
	selected: string | null;
	onSelect(node: WireTreeNode): void;
	level?: number;
}) {
	return (
		<ul className={level === 1 ? "file-tree" : "file-tree__branch"}>
			{nodes.map((node) => {
				const key = pathKey(node.path);
				const isDirectory = node.kind === "directory";
				const isBlocked = !node.operable;
				return (
					<li key={key || node.name}>
						<button
							type="button"
							aria-pressed={selected === key}
							className={`file-node file-node--${node.kind}${selected === key ? " is-selected" : ""}`}
							onClick={() => onSelect(node)}
							title={isBlocked ? `${node.name} is a blocked ${node.kind}` : formatProjectPath(node.path)}
						>
							<span className="file-node__guide" aria-hidden="true" />
							<Glyph>{isDirectory ? "▾" : node.kind === "symlink" ? "⊘" : "·"}</Glyph>
							<span className="file-node__kind" aria-hidden="true">
								{isDirectory ? "▱" : node.kind === "symlink" ? "↗" : "≡"}
							</span>
							<span className="file-node__name">{node.name}</span>
							{isBlocked && <span className="file-node__blocked">blocked</span>}
						</button>
						{node.children && node.children.length > 0 && (
							<TreeBranch nodes={node.children} selected={selected} onSelect={onSelect} level={level + 1} />
						)}
					</li>
				);
			})}
		</ul>
	);
}

function OpenProjectForm({ onOpen, onBrowse, busy }: {
	onOpen(path: string): void;
	onBrowse(): void;
	busy: boolean;
}) {
	const [path, setPath] = useState("");
	const inputId = useId();
	function submit(event: FormEvent) {
		event.preventDefault();
		const trimmed = path.trim();
		if (trimmed.length === 0) return;
		onOpen(trimmed);
	}
	return (
		<form className="open-project" onSubmit={submit}>
			<label htmlFor={inputId}>Project folder</label>
			<div className="open-project__row">
				<input
					id={inputId}
					name="projectPath"
					value={path}
					spellCheck={false}
					autoComplete="off"
					placeholder="/home/you/code/your-project"
					onChange={(event) => setPath(event.target.value)}
				/>
				<button type="submit" className="button button--primary" disabled={busy || path.trim().length === 0}>
					Open
				</button>
			</div>
			<button type="button" className="button button--quiet open-project__browse" onClick={onBrowse}>
				Browse folders
			</button>
		</form>
	);
}

function SessionRow({ session, open, actions, busy, onDelete }: {
	session: WireSessionSummary;
	open: OpenWorkspaceState;
	actions: WorkbenchActions;
	busy: boolean;
	onDelete(session: WireSessionSummary): void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(session.label ?? "");
	const bound = open.clio.session?.id === session.id;
	const unknown = session.state === "unknown";
	const capabilities = open.clio.capabilities;
	const title = session.label ?? (session.preview.length > 0 ? session.preview : "Untitled session");

	function commitLabel(event: FormEvent) {
		event.preventDefault();
		actions.labelSession(open.project.id, session.id, draft.trim());
		setEditing(false);
	}

	return (
		<article className={`session-row${bound ? " is-bound" : ""}`}>
			<span className={`session-row__mark session-row__mark--${session.state}`} aria-hidden="true" />
			<div className="session-row__body">
				{editing
					? (
						<form className="session-row__rename" onSubmit={commitLabel}>
							<label>
								<span className="sr-only">Label for {title}</span>
								<input
									value={draft}
									maxLength={256}
									placeholder="Name this session"
									onChange={(event) => setDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Escape") {
											setDraft(session.label ?? "");
											setEditing(false);
										}
									}}
								/>
							</label>
							<button type="submit" className="button button--quiet">Save</button>
						</form>
					)
					: <h3>{title}</h3>}
				<p className="session-row__meta">
					{SESSION_STATE_LABELS[session.state]} · {session.turns} turns · {formatTimestamp(session.updatedAt)}
					{session.target === null ? "" : ` · ${session.target}`}
					{session.model === null ? "" : ` · ${session.model}`}
				</p>
				{unknown && <p className="session-row__note">{UNKNOWN_SESSION_NOTE}</p>}
			</div>
			<div className="session-row__actions">
				{bound ? <span className="session-row__badge">bound</span> : (
					<button
						type="button"
						className="button button--quiet"
						disabled={busy || unknown || capabilities?.load !== true}
						onClick={() => actions.loadSession(open.project.id, session.id)}
					>
						Resume
					</button>
				)}
				{!editing && capabilities?.label === true && (
					<button
						type="button"
						className="button button--quiet"
						disabled={busy}
						onClick={() => {
							setDraft(session.label ?? "");
							setEditing(true);
						}}
					>
						Rename
					</button>
				)}
				<button
					type="button"
					className="button button--quiet"
					disabled={busy || bound || unknown || capabilities?.delete !== true}
					onClick={() => onDelete(session)}
				>
					Delete
				</button>
			</div>
		</article>
	);
}

/** Deleting a session is permanent, so Workbench asks before the server is told. */
function SessionDeleteModal({ session, projectId, actions, onClose }: {
	session: WireSessionSummary;
	projectId: string;
	actions: WorkbenchActions;
	onClose(): void;
}) {
	const title = session.label ?? (session.preview.length > 0 ? session.preview : "Untitled session");
	return (
		<Modal title="Delete this session" eyebrow="PERMANENT · NOT RECOVERABLE" onClose={onClose}>
			<div className="delete-confirmation">
				<div className="delete-confirmation__target">
					<span>SESSION</span>
					<code>{title}</code>
				</div>
				<p>
					Clio deletes this session and its {session.turns}{" "}
					recorded turns. Workbench cannot bring them back, and neither can Clio.
				</p>
				<div className="modal__actions">
					<button type="button" className="button button--quiet" onClick={onClose}>Keep session</button>
					<button
						type="button"
						className="button button--danger"
						onClick={() => {
							actions.deleteSession(projectId, session.id);
							onClose();
						}}
					>
						Delete permanently
					</button>
				</div>
			</div>
		</Modal>
	);
}

function ProjectRail({
	state,
	dispatch,
	actions,
	selectedNode,
	onSelectNode,
	onFileDialog,
	onDeleteSession,
	isDrawer,
	obscured,
}: {
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
	selectedNode: WireTreeNode | null;
	onSelectNode(node: WireTreeNode): void;
	onFileDialog(dialog: FileDialog): void;
	onDeleteSession(session: WireSessionSummary): void;
	isDrawer: boolean;
	obscured: boolean;
}) {
	const open = state.open;
	// Only a live turn locks project switching; having no project open must never
	// disable the control that opens one.
	const busy = open !== null && isPromptBlocked(open);
	const unavailable = obscured || (isDrawer && !state.leftDrawerOpen);
	return (
		<aside
			id="project-rail"
			className={`left-rail${isDrawer && state.leftDrawerOpen ? " is-open" : ""}`}
			aria-label="Projects, files, and sessions"
			aria-hidden={unavailable ? true : undefined}
			inert={unavailable}
		>
			<div className="left-rail__brand">
				<BrandLockup compact />
				{isDrawer && (
					<button
						type="button"
						className="icon-button left-rail__close"
						onClick={() => dispatch({ type: "drawer.left", open: false })}
					>
						<Glyph>×</Glyph>
						<span className="sr-only">Close projects and files</span>
					</button>
				)}
			</div>

			<section className="rail-section rail-section--projects" aria-labelledby="project-library-title">
				<PanelHeading eyebrow="PROJECT" title="Open a folder" headingId="project-library-title" />
				<OpenProjectForm
					onOpen={(path) => actions.openProject(path)}
					onBrowse={() => actions.browseProjects()}
					busy={busy}
				/>
				<div className="project-list">
					{state.recent.length === 0
						? <p className="rail-empty">No project has been opened yet.</p>
						: state.recent.map((project: WireProjectSummary) => {
							const isOpen = open?.project.id === project.id;
							const missing = !project.available;
							return (
								<div className={`project-card-row${missing ? " is-missing" : ""}`} key={project.id}>
									<button
										type="button"
										className={`project-card${isOpen ? " is-selected" : ""}`}
										aria-pressed={isOpen}
										disabled={busy || missing}
										onClick={() => actions.selectProject(project.id)}
										title={project.rootPath}
									>
										<span className="project-card__body">
											<strong>{project.displayName}</strong>
											<small>{project.rootPath}</small>
											{missing && <small className="project-card__missing">cannot be opened</small>}
										</span>
									</button>
									{missing
										? (
											<div className="project-recovery">
												<p className="project-recovery__reason">
													Workbench can no longer open this folder. It may have been moved, renamed, or deleted, or it
													may now be a location Workbench refuses to open. Removing it from this list changes nothing on
													disk.
												</p>
												<button
													type="button"
													className="button button--quiet"
													disabled={busy}
													onClick={() => actions.forgetProject(project.id)}
												>
													Remove {project.displayName} from this list
												</button>
											</div>
										)
										: (
											<button
												type="button"
												className="icon-button"
												disabled={busy}
												onClick={() => actions.forgetProject(project.id)}
											>
												<Glyph>×</Glyph>
												<span className="sr-only">Forget {project.displayName}</span>
											</button>
										)}
								</div>
							);
						})}
				</div>
				{busy && <p className="project-lock-note">Clio is working. Projects can be switched between turns.</p>}
			</section>

			{open && (
				<>
					<section className="rail-section rail-section--files" aria-labelledby="files-title">
						<PanelHeading
							eyebrow="FILES"
							title={open.project.displayName}
							headingId="files-title"
							action={
								<button
									type="button"
									className="icon-button"
									onClick={() => actions.refreshTree(open.project.id)}
									title="Refresh project tree"
								>
									<Glyph>⟳</Glyph>
									<span className="sr-only">Refresh project tree</span>
								</button>
							}
						/>
						<div className="file-toolbar" aria-label="File operations">
							<button type="button" className="button button--quiet" onClick={() => onFileDialog("create-file")}>
								New file
							</button>
							<button type="button" className="button button--quiet" onClick={() => onFileDialog("create-folder")}>
								New folder
							</button>
							<button
								type="button"
								className="button button--quiet"
								disabled={selectedNode === null}
								onClick={() => onFileDialog("move")}
							>
								Rename
							</button>
							<button
								type="button"
								className="button button--quiet"
								disabled={selectedNode === null}
								onClick={() => onFileDialog("delete")}
							>
								Delete
							</button>
						</div>
						<div className="tree-viewport">
							{open.tree.length === 0
								? <div className="compact-empty">This project has no files yet.</div>
								: (
									<TreeBranch
										nodes={open.tree}
										selected={selectedNode ? pathKey(selectedNode.path) : null}
										onSelect={onSelectNode}
									/>
								)}
							{open.treeTruncated && <p className="tree-note">Tree capped at the project safety limit.</p>}
						</div>
					</section>

					<section className="rail-section rail-section--sessions" aria-labelledby="sessions-title">
						<PanelHeading
							eyebrow="SESSIONS"
							title="Conversations"
							headingId="sessions-title"
							action={
								<button
									type="button"
									className="button button--quiet"
									disabled={busy}
									onClick={() => actions.newSession(open.project.id)}
								>
									New
								</button>
							}
						/>
						<div className="session-list">
							{open.sessions.length === 0
								? <p className="rail-empty">Clio has no session for this project yet.</p>
								: open.sessions.map((session) => (
									<SessionRow
										key={session.id}
										session={session}
										open={open}
										actions={actions}
										busy={busy}
										onDelete={onDeleteSession}
									/>
								))}
						</div>
						{open.sessionsTruncated && (
							<p className="tree-note">This list is shortened; Clio has more sessions than are shown.</p>
						)}
						{open.clio.capabilities?.list === false && (
							<p className="tree-note">This Clio cannot list its earlier sessions over ACP.</p>
						)}
					</section>
				</>
			)}
		</aside>
	);
}

/** A tool that has been open this long is worth saying so about, in seconds. */
const LONG_RUNNING_TOOL_SECONDS = 30;

function TimelineCard({ item, nowMs }: { item: WireTimelineItem; nowMs: number }) {
	const startedMs = item.startedAt === null ? Number.NaN : Date.parse(item.startedAt);
	const activeSeconds = item.status === "active" && Number.isFinite(startedMs)
		? Math.max(0, Math.floor((nowMs - startedMs) / 1_000))
		: 0;
	const longRunning = item.kind === "tool" && activeSeconds >= LONG_RUNNING_TOOL_SECONDS;
	return (
		<article
			className={`timeline-card timeline-card--${item.kind} is-${item.status}${
				item.origin === "replay" ? " timeline-card--replay" : ""
			}${longRunning ? " timeline-card--long" : ""}`}
		>
			<div className="timeline-card__meta">
				<span className="timeline-card__kind">{item.kind}</span>
				<span className="timeline-card__source">{SOURCE_LABELS[item.source]}</span>
				{item.origin === "replay" && <span className="timeline-card__replay">earlier</span>}
				{longRunning && <span className="timeline-card__long">still running · {formatDuration(activeSeconds)}</span>}
			</div>
			<h3>{item.title}</h3>
			<p className="timeline-card__summary">{item.summary}</p>
			{item.detail && <pre className="timeline-card__detail">{item.detail}</pre>}
			<div className="timeline-card__status">
				<StatusMark
					tone={item.status === "failed"
						? "error"
						: item.status === "complete"
						? "success"
						: item.status === "replayed"
						? "neutral"
						: "info"}
					label={item.status}
				/>
				{item.startedAt !== null && <time dateTime={item.startedAt}>{formatTimestamp(item.startedAt)}</time>}
			</div>
		</article>
	);
}

function PermissionCard({
	permission,
	escalated,
	elapsed,
	onResolve,
}: {
	permission: WirePendingPermission;
	escalated: boolean;
	elapsed: number;
	onResolve(decision: "allow-once" | "reject"): void;
}) {
	const locations = permission.locations.map((location) => formatProjectPath(location));
	return (
		<section
			className={`approval-card${escalated ? " approval-card--escalated" : ""}`}
			aria-labelledby="permission-title"
		>
			<div className="approval-card__signal" aria-hidden="true">!</div>
			<div className="approval-card__body">
				<div className="eyebrow">APPROVAL NEEDED · ONE USE</div>
				<h3 id="permission-title">{permission.title}</h3>
				<p>
					{permission.kind} access to {locations.length === 0 ? "this turn" : locations.join(", ")}. Waiting{" "}
					{formatDuration(elapsed)}.
				</p>
				<p className="approval-card__note">
					Nothing runs until you answer. Workbench never answers for you.
				</p>
				<div className="approval-card__actions">
					<button type="button" className="button button--quiet" onClick={() => onResolve("reject")}>Reject</button>
					<button type="button" className="button button--action" onClick={() => onResolve("allow-once")}>
						Allow once
					</button>
				</div>
			</div>
		</section>
	);
}

/**
 * Sits above the scrolling conversation rather than inside it, because the card
 * the operator missed in the recorded session was anchored where the timeline
 * happened to be. Prominent but never focus-trapping: the operator may keep
 * reading, scrolling, and typing while an approval waits.
 */
function ApprovalBanner({
	permission,
	escalated,
	elapsed,
	onResolve,
}: {
	permission: WirePendingPermission;
	escalated: boolean;
	elapsed: number;
	onResolve(decision: "allow-once" | "reject"): void;
}) {
	return (
		<section
			className={`approval-banner${escalated ? " approval-banner--escalated" : ""}`}
			role="region"
			aria-labelledby="approval-banner-title"
		>
			<div className="approval-banner__signal" aria-hidden="true">!</div>
			<div className="approval-banner__body">
				<div className="eyebrow">{escalated ? "APPROVAL WAITING · ESCALATED" : "APPROVAL NEEDED"}</div>
				<strong id="approval-banner-title">{permission.title}</strong>
				<span className="approval-banner__facts">
					{permission.kind} · waiting {formatDuration(elapsed)}
				</span>
			</div>
			<div className="approval-banner__actions">
				<button type="button" className="button button--quiet" onClick={() => onResolve("reject")}>
					Reject
				</button>
				<button type="button" className="button button--action" onClick={() => onResolve("allow-once")}>
					Allow once
				</button>
				<span className="approval-banner__keys">Alt+A allows once · Alt+R rejects</span>
			</div>
		</section>
	);
}

function FirstRunGuide({ state, onBrowse }: { state: AppState; onBrowse(): void }) {
	return (
		<section className="first-run" aria-labelledby="first-run-title">
			<div className="first-run__intro">
				<div className="eyebrow">A FIELD OBSERVATORY FOR CODE</div>
				<h2 id="first-run-title">Bring a research folder. Keep every decision visible.</h2>
				<p>
					Workbench gives one real Clio process a bounded place to work, then turns its requests, actions, and outcomes
					into a record you can inspect. You can start with a question; you do not need to start with a command.
				</p>
				<div className="first-run__actions">
					<button type="button" className="button button--primary" onClick={onBrowse}>
						Choose a project folder
					</button>
					<span>or enter a path in the Project panel</span>
				</div>
			</div>

			<ol className="first-run__steps" aria-label="How Workbench works">
				<li>
					<span aria-hidden="true">01</span>
					<div>
						<strong>Open one project</strong>
						<p>Choose the folder that contains your notes, data, scripts, or application.</p>
					</div>
				</li>
				<li>
					<span aria-hidden="true">02</span>
					<div>
						<strong>Describe the outcome</strong>
						<p>Ask in your own words. Clio plans and uses the tools its configuration permits.</p>
					</div>
				</li>
				<li>
					<span aria-hidden="true">03</span>
					<div>
						<strong>Inspect the evidence</strong>
						<p>See what was observed, what Clio reported, and where your approval was required.</p>
					</div>
				</li>
			</ol>

			<div className="first-run__assurances">
				<article>
					<div className="eyebrow">PROJECT BOUNDARY</div>
					<p>{state.securityNote}</p>
				</article>
				<article>
					<div className="eyebrow">LOCAL CONTROL</div>
					<p>
						The Workbench control channel stays on this machine. Prompts go only to the Clio target you configure.
					</p>
				</article>
				<article>
					<div className="eyebrow">WORKBENCH STATE</div>
					<p>{state.stateDirNote}</p>
				</article>
			</div>
		</section>
	);
}

const TRACE_LIMIT = 24;
const STARTER_PROMPTS = [
	"Map this project and explain how its parts fit together.",
	"Run the existing checks and summarize what the evidence shows.",
	"Help me plan a careful change without editing anything yet.",
] as const;

function EvidenceRail({
	state,
	nowMs,
	isDrawer,
	drawerOpen,
	onClose,
	obscured,
}: {
	state: AppState;
	nowMs: number;
	isDrawer: boolean;
	drawerOpen: boolean;
	onClose(): void;
	obscured: boolean;
}) {
	const open = state.open;
	const timeline = open?.projection.timeline ?? [];
	const activeTurn = open?.projection.activeTurn ?? null;
	const trace = timeline.slice(-TRACE_LIMIT);
	const sourceCounts = (Object.keys(SOURCE_GUIDANCE) as WireEventSource[]).map((source) => ({
		source,
		count: timeline.filter((item) => item.source === source).length,
	})).filter(({ count }) => count > 0);
	const toolCount = timeline.filter((item) => item.kind === "tool").length;
	const outcomeCount = timeline.filter((item) => item.kind === "outcome").length;
	const attentionCount = timeline.filter((item) => item.status === "failed" || item.status === "canceled").length;
	const startedMs = activeTurn === null ? Number.NaN : Date.parse(activeTurn.startedAt);
	const activeSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs - startedMs) / 1_000)) : 0;
	const unavailable = obscured || (isDrawer && !drawerOpen);

	return (
		<aside
			id="evidence-rail"
			className={`evidence-rail instrument-panel${isDrawer && drawerOpen ? " is-open" : ""}`}
			aria-label="Run and evidence overview"
			aria-hidden={unavailable ? true : undefined}
			inert={unavailable}
		>
			<header className="evidence-rail__header">
				<div>
					<div className="eyebrow">OBSERVATORY</div>
					<h2>Run record</h2>
				</div>
				{isDrawer && (
					<button type="button" className="icon-button evidence-rail__close" onClick={onClose}>
						<Glyph>×</Glyph>
						<span className="sr-only">Close run and evidence overview</span>
					</button>
				)}
			</header>

			<div className="evidence-rail__scroll">
				<section className="observer-section" aria-labelledby="observer-now-title">
					<div className="observer-section__heading">
						<div>
							<div className="eyebrow">RUN NOW</div>
							<h3 id="observer-now-title">Current state</h3>
						</div>
						{open !== null && (
							<StatusMark
								tone={PHASE_PRESENTATION[open.clio.phase].tone}
								label={PHASE_PRESENTATION[open.clio.phase].label}
							/>
						)}
					</div>
					{open === null
						? (
							<div className="observer-empty">
								<div className="observer-empty__mark" aria-hidden="true">◎</div>
								<strong>Observation starts with a folder.</strong>
								<p>No run facts exist yet, so this panel intentionally has no telemetry to show.</p>
							</div>
						)
						: (
							<>
								<p className="observer-lede">
									{activeTurn === null
										? "Clio is ready for the next research question."
										: `Clio has been working for ${formatDuration(activeSeconds)}.`}
								</p>
								{activeTurn !== null && (
									<div className="observer-activity">
										<div>
											<span>TOOL CALLS</span>
											<strong>{activeTurn.toolCalls}</strong>
										</div>
										<div>
											<span>REPEATED SHAPES</span>
											<strong>{activeTurn.repeatedShapes}</strong>
										</div>
										{activeTurn.lastToolTitle !== null && (
											<p>
												<span>CLIO'S LATEST TOOL</span>
												<strong>{activeTurn.lastToolTitle}</strong>
											</p>
										)}
									</div>
								)}
							</>
						)}
				</section>

				{open !== null && (
					<section className="observer-section" aria-labelledby="observer-session-title">
						<div className="eyebrow">SESSION ROUTING</div>
						<h3 id="observer-session-title">Bound by Clio</h3>
						{open.clio.session === null
							? <p className="observer-note">No session is bound to this project.</p>
							: (
								<dl className="observer-facts">
									<div>
										<dt>Target</dt>
										<dd>{open.clio.session.target ?? "unselected"}</dd>
									</div>
									<div>
										<dt>Model</dt>
										<dd>{open.clio.session.model ?? "unselected"}</dd>
									</div>
									<div>
										<dt>Working freedom</dt>
										<dd>{AUTONOMY_LABELS[open.clio.session.autonomy]}</dd>
									</div>
								</dl>
							)}
					</section>
				)}

				<section className="observer-section" aria-labelledby="observer-evidence-title">
					<div className="observer-section__heading">
						<div>
							<div className="eyebrow">RECORDED EVIDENCE</div>
							<h3 id="observer-evidence-title">Timeline at a glance</h3>
						</div>
						<strong className="observer-total">{timeline.length}</strong>
					</div>
					{timeline.length === 0
						? <p className="observer-note">The first request will begin the evidence record.</p>
						: (
							<>
								<ol className="evidence-trace" aria-label="Most recent recorded events">
									{trace.map((item) => (
										<li
											key={item.id}
											className={`evidence-trace__item evidence-trace__item--${item.kind} is-${item.status}`}
											title={`${item.title} — ${SOURCE_LABELS[item.source]} — ${item.status}`}
										>
											<span className="sr-only">
												{item.kind}: {item.title}, {SOURCE_LABELS[item.source]}, {item.status}
											</span>
										</li>
									))}
								</ol>
								<div className="observer-counts">
									<div>
										<span>Actions</span>
										<strong>{toolCount}</strong>
									</div>
									<div>
										<span>Outcomes</span>
										<strong>{outcomeCount}</strong>
									</div>
									<div>
										<span>Failed / stopped</span>
										<strong>{attentionCount}</strong>
									</div>
								</div>
								{(open?.projection.timelineTruncated === true || open?.clio.session?.replayTruncated === true) && (
									<p className="observer-note">This view is shortened; Clio still holds the full context.</p>
								)}
							</>
						)}
				</section>

				<section className="observer-section" aria-labelledby="observer-sources-title">
					<div className="eyebrow">PROVENANCE</div>
					<h3 id="observer-sources-title">Where each fact came from</h3>
					{sourceCounts.length === 0
						? <p className="observer-note">Sources appear here only after Clio records activity.</p>
						: (
							<ul className="source-ledger">
								{sourceCounts.map(({ source, count }) => (
									<li key={source}>
										<span className={`source-ledger__mark source-ledger__mark--${source}`} aria-hidden="true" />
										<div>
											<strong>{SOURCE_GUIDANCE[source].label}</strong>
											<p>{SOURCE_GUIDANCE[source].description}</p>
										</div>
										<code>{count}</code>
									</li>
								))}
							</ul>
						)}
					<p className="observer-method-note">
						This panel summarizes the record. It never infers completion from silence or invents measurements.
					</p>
				</section>
			</div>
		</aside>
	);
}

function ConversationCanvas({
	state,
	dispatch,
	actions,
	obscured,
	nowMs,
	inspectorOpen,
	onInspectorToggle,
}: {
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
	obscured: boolean;
	nowMs: number;
	inspectorOpen: boolean;
	onInspectorToggle(): void;
}) {
	const open = state.open;
	const [prompt, setPrompt] = useState("");
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const projection = open?.projection ?? null;
	const activeTurn = projection?.activeTurn ?? null;
	const pendingPermission = projection?.pendingPermission ?? null;
	const elapsed = useElapsedSeconds(activeTurn?.startedAt ?? null);
	const busy = isPromptBlocked(open);
	const clioOccupied = open !== null && busy;
	const canSubmit = open !== null && !busy && prompt.trim().length > 0 && state.pendingTurnStart === null;
	const permissionWait = pendingPermission === null
		? 0
		: Math.max(0, Math.floor((nowMs - Date.parse(pendingPermission.requestedAt)) / 1_000));
	const permissionEscalated = pendingPermission !== null && nowMs >= Date.parse(pendingPermission.escalateAt);

	function resolvePending(decision: "allow-once" | "reject"): void {
		if (open === null || pendingPermission === null || activeTurn === null) return;
		actions.resolvePermission(open.project.id, activeTurn.turnId, pendingPermission.permissionId, decision);
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!canSubmit || open === null) return;
		actions.startTurn(open.project.id, prompt.trim());
		setPrompt("");
	}

	function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit(event as unknown as FormEvent);
		}
	}

	function startFromExample(example: string): void {
		setPrompt(example);
		requestAnimationFrame(() => promptRef.current?.focus());
	}

	return (
		<main
			className="conversation"
			id="conversation"
			aria-hidden={obscured ? true : undefined}
			inert={obscured}
		>
			<header className="conversation__header">
				<div className="mobile-controls">
					<button
						type="button"
						className="icon-button"
						aria-controls="project-rail"
						aria-expanded={state.leftDrawerOpen}
						onClick={() => dispatch({ type: "drawer.left", open: !state.leftDrawerOpen })}
					>
						<Glyph>≡</Glyph>
						<span className="sr-only">Open projects and files</span>
					</button>
				</div>
				<div className="conversation__identity">
					<div className="eyebrow">ACTIVE PROJECT</div>
					<h1>{open === null ? "No project open" : open.project.displayName}</h1>
					{open && <p className="conversation__root">{open.project.rootPath}</p>}
				</div>
				<div className="conversation__telemetry">
					{open && (
						<StatusMark
							tone={PHASE_PRESENTATION[open.clio.phase].tone}
							label={PHASE_PRESENTATION[open.clio.phase].label}
						/>
					)}
					<button
						type="button"
						className="button button--quiet"
						onClick={() => dispatch({ type: "settings.opened", open: true })}
					>
						Settings
					</button>
				</div>
				<div className="mobile-controls mobile-controls--evidence">
					<button
						type="button"
						className="icon-button"
						aria-controls="evidence-rail"
						aria-expanded={inspectorOpen}
						onClick={onInspectorToggle}
					>
						<Glyph>◫</Glyph>
						<span className="sr-only">Open run and evidence overview</span>
					</button>
				</div>
			</header>

			{pendingPermission !== null && activeTurn !== null && (
				<ApprovalBanner
					permission={pendingPermission}
					escalated={permissionEscalated}
					elapsed={permissionWait}
					onResolve={resolvePending}
				/>
			)}

			{/* Focusable so a keyboard user can scroll the conversation without a pointer. */}
			<div className="conversation__scroll" tabIndex={0} role="region" aria-label="Conversation history">
				{open === null ? <FirstRunGuide state={state} onBrowse={() => actions.browseProjects()} /> : (
					<>
						{open.clio.lastFailure && (
							<section className="conversation__failure" role="status">
								<div className="eyebrow">CLIO REPORTED A FAILURE</div>
								<p>{open.clio.lastFailure.summary}</p>
								<code>{open.clio.lastFailure.code}</code>
							</section>
						)}
						{(projection?.timelineTruncated === true || open.clio.session?.replayTruncated === true) && (
							<p className="timeline-note">Earlier turns are not shown; Clio still has the full context.</p>
						)}
						<section
							className="evidence-timeline"
							aria-label="Request, work, approval, and outcome timeline"
							aria-live="polite"
						>
							{projection === null || projection.timeline.length === 0
								? (
									<div className="timeline-empty">
										<div className="timeline-empty__reticle" aria-hidden="true">◎</div>
										<div>
											<div className="eyebrow">NEW RESEARCH THREAD</div>
											<h2>What would you like to understand or change?</h2>
											<p>Start in your own words, or use one of these as a starting point.</p>
										</div>
										<div className="starter-prompts" aria-label="Example prompts">
											{STARTER_PROMPTS.map((example) => (
												<button
													type="button"
													key={example}
													onClick={() => startFromExample(example)}
												>
													<span aria-hidden="true">↗</span>
													{example}
												</button>
											))}
										</div>
									</div>
								)
								: projection.timeline.map((item) => <TimelineCard item={item} nowMs={nowMs} key={item.id} />)}
						</section>
						{pendingPermission !== null && activeTurn !== null && (
							<PermissionCard
								permission={pendingPermission}
								escalated={permissionEscalated}
								elapsed={permissionWait}
								onResolve={resolvePending}
							/>
						)}
					</>
				)}
			</div>

			<form className="composer" onSubmit={submit}>
				<div className="composer__mode">
					<span className="composer__mode-label">
						{open === null ? "START" : clioOccupied ? "RUNNING" : "MESSAGE"}
					</span>
					<span className="composer__status" role="status">
						{activeTurn
							? `${formatDuration(elapsed)} · ${activeTurn.toolCalls} tool calls${
								activeTurn.lastToolTitle === null ? "" : ` · ${activeTurn.lastToolTitle}`
							}${activeTurn.repeatedShapes > 0 ? ` · ${activeTurn.repeatedShapes} repeated` : ""}`
							: open === null
							? "Open a project folder to talk to Clio."
							: "Ready for your next prompt."}
					</span>
				</div>
				<div className="composer__input-row">
					<textarea
						ref={promptRef}
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={onComposerKeyDown}
						placeholder={open === null ? "Open a project first" : "Ask Clio to do something in this project"}
						aria-label="Prompt for Clio"
						rows={3}
						disabled={open === null}
					/>
					{activeTurn
						? (
							<button
								type="button"
								className="composer__submit composer__submit--cancel"
								onClick={() => open && actions.cancelTurn(open.project.id, activeTurn.turnId)}
							>
								Stop
							</button>
						)
						: (
							<button type="submit" className="composer__submit" disabled={!canSubmit}>
								Send
							</button>
						)}
				</div>
				<div className="composer__footer">
					{clioOccupied && !activeTurn && (
						<span className="composer__notice">Clio is finishing the previous prompt.</span>
					)}
					<span className="composer__shortcut">Ctrl or Cmd + Enter sends</span>
					<span className="composer__privacy">Prompts go only to the Clio target you configured.</span>
				</div>
			</form>
		</main>
	);
}

function Modal(
	{ title, eyebrow, children, onClose, size = "default" }: {
		title: string;
		eyebrow: string;
		children: ReactNode;
		onClose(): void;
		size?: "default" | "wide";
	},
) {
	const headingId = useId();
	const container = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		container.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
		function constrainKeyboardFocus(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				closeRef.current();
				return;
			}
			if (container.current) containTabKey(event, container.current);
		}
		document.addEventListener("keydown", constrainKeyboardFocus);
		return () => {
			document.removeEventListener("keydown", constrainKeyboardFocus);
			if (previouslyFocused?.isConnected) previouslyFocused.focus();
		};
	}, []);
	return (
		<div
			className="modal-backdrop"
			role="presentation"
			onMouseDown={(event) => event.target === event.currentTarget && onClose()}
		>
			<div
				className={`modal modal--${size}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={headingId}
				ref={container}
				tabIndex={-1}
			>
				<div className="modal__header">
					<div>
						<div className="eyebrow">{eyebrow}</div>
						<h2 id={headingId}>{title}</h2>
					</div>
					<button type="button" className="icon-button" onClick={onClose}>
						<Glyph>×</Glyph>
						<span className="sr-only">Close</span>
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

function BrowseModal({ state, actions, onClose }: {
	state: AppState;
	actions: WorkbenchActions;
	onClose(): void;
}) {
	const listing = state.browse;
	if (listing === null) return null;
	return (
		<Modal title="Choose a project folder" eyebrow="DIRECTORIES ONLY" onClose={onClose}>
			<div className="browse">
				<p className="browse__path">
					<code>{listing.path}</code>
				</p>
				{listing.reason !== null && <p className="browse__reason">{listing.reason}</p>}
				<div className="browse__actions">
					<button
						type="button"
						className="button button--quiet"
						disabled={listing.parent === null}
						onClick={() => listing.parent !== null && actions.browseProjects(listing.parent)}
					>
						Up one folder
					</button>
					<button
						type="button"
						className="button button--primary"
						disabled={!listing.openable}
						onClick={() => {
							actions.openProject(listing.path);
							onClose();
						}}
					>
						Open this folder
					</button>
				</div>
				<ul className="browse__list">
					{listing.entries.length === 0 && <li className="browse__empty">No folders here.</li>}
					{listing.entries.map((entry) => (
						<li key={entry.name}>
							<button
								type="button"
								className={`browse__entry${entry.hidden ? " is-hidden-entry" : ""}`}
								onClick={() => actions.browseProjects(`${listing.path.replace(/\/$/u, "")}/${entry.name}`)}
							>
								<Glyph>▱</Glyph>
								<span>{entry.name}</span>
								{entry.guarded && <span className="browse__flag">not openable</span>}
							</button>
						</li>
					))}
				</ul>
				{listing.truncated && <p className="browse__note">Only the first folders are listed.</p>}
			</div>
		</Modal>
	);
}

/** One configured target, its models, and the outcome of a probe if one happened. */
function TargetRow({ target, projectId, actions }: {
	target: WireTarget;
	projectId: string;
	actions: WorkbenchActions;
}) {
	const health = target.health;
	return (
		<li className="target-row">
			<div className="target-row__identity">
				<strong>{target.id}</strong>
				<small>{target.isOrchestrator ? `${target.runtime} · orchestrator` : target.runtime}</small>
				<small className="target-row__models">
					{target.models.length === 0 ? "no models reported" : target.models.join(", ")}
				</small>
			</div>
			<div className="target-row__health">
				{health === null ? <small className="target-row__unprobed">not probed</small> : (
					<>
						<StatusMark tone={health.healthy ? "success" : "error"} label={health.healthy ? "healthy" : "unhealthy"} />
						<small>
							{health.reason ?? (health.latencyMs === null ? "no latency reported" : `${health.latencyMs} ms`)}
							{` · probed ${formatTimestamp(health.probedAt)}`}
						</small>
					</>
				)}
				<button
					type="button"
					className="button button--quiet"
					onClick={() => actions.probeTarget(projectId, target.id)}
				>
					Probe {target.id}
				</button>
			</div>
		</li>
	);
}

/**
 * The only place that may ask the browser for notification permission. The
 * effective state is the browser's, not a stored preference, so the control
 * never claims notifications are on when the browser is blocking them.
 */
function ApprovalNotificationSetting(
	{ enabled, onChange }: { enabled: boolean; onChange(enabled: boolean): void },
) {
	const [granted, setGranted] = useState<NotificationPermission | "unsupported">(() =>
		typeof Notification === "undefined" ? "unsupported" : Notification.permission
	);
	return (
		<section className="settings__notifications" aria-labelledby="settings-notifications-title">
			<h3 id="settings-notifications-title" className="settings__heading">Approvals</h3>
			{granted === "unsupported" && <p className="settings__note">This browser cannot post desktop notifications.</p>}
			{granted === "denied" && <p className="settings__note">Your browser is blocking notifications for this page.</p>}
			{granted === "default" && (
				<button
					type="button"
					className="button button--quiet"
					onClick={() => {
						void Notification.requestPermission().then((next) => setGranted(next)).catch(() => undefined);
					}}
				>
					Desktop notifications for approvals
				</button>
			)}
			{granted === "granted" && (
				<label className="settings__toggle">
					<input type="checkbox" checked={enabled} onChange={(event) => onChange(event.target.checked)} />
					Desktop notifications for approvals
				</label>
			)}
			<p className="settings__note">
				A notification carries the tool title only. Workbench never puts a project path in one.
			</p>
		</section>
	);
}

function SettingsModal({ state, actions, dispatch, onClose }: {
	state: AppState;
	actions: WorkbenchActions;
	dispatch: Dispatch<AppAction>;
	onClose(): void;
}) {
	const onNotificationsChange = (enabled: boolean) => dispatch({ type: "notifications.set", enabled });
	const open = state.open;
	const busy = isPromptBlocked(open);
	const settings = open?.settings ?? null;
	const editable = settings?.editable ?? [];
	const targets = open?.targets ?? null;
	return (
		<Modal title="Clio settings" eyebrow="CONTROLS WITH EXPLICIT SCOPE" onClose={onClose} size="wide">
			<div className="settings">
				<div className="settings__intro">
					<div>
						<div className="eyebrow">CONFIGURATION</div>
						<h3>How Clio will work</h3>
					</div>
					<p>
						Workbench reads and writes these values through Clio. Timing labels distinguish this session from the next
						turn or a newly created session.
					</p>
				</div>
				{open === null && <p>Open a project before reading Clio's settings.</p>}
				{open !== null && open.clio.capabilities?.settings !== true && (
					<p className="settings__unavailable">This Clio does not expose settings over ACP.</p>
				)}
				{open !== null && settings === null && open.clio.capabilities?.settings === true && (
					<button
						type="button"
						className="button button--quiet"
						onClick={() => actions.getSettings(open.project.id)}
					>
						Load settings
					</button>
				)}
				{open !== null && settings !== null && (
					<dl className="settings__list">
						{Object.entries(settings.settings).map(([key, value]) => {
							const options = settings.options[key] ?? [];
							const canEdit = editable.includes(key) && !busy;
							const guidance = SETTING_GUIDANCE[key] ?? {
								label: key,
								description: "A setting Clio exposes to this Workbench session.",
								scope: null,
							};
							return (
								<div key={key}>
									<dt>
										<div className="settings__label-line">
											<strong>{guidance.label}</strong>
											{guidance.scope !== null && <span>{guidance.scope}</span>}
										</div>
										<p>{guidance.description}</p>
										<code>{key}</code>
									</dt>
									<dd>
										{options.length === 0 ? <code>{value ?? "unset"}</code> : (
											<select
												aria-label={`Set ${key}`}
												value={value ?? ""}
												disabled={!canEdit}
												onChange={(event) => {
													const patch = settingsPatch(key, event.target.value);
													if (patch !== null) actions.patchSettings(open.project.id, patch);
												}}
											>
												{(key === "orchestrator.target" || key === "orchestrator.model") && (
													<option value="">unset</option>
												)}
												{options.map((option) => <option value={option} key={option}>{option}</option>)}
											</select>
										)}
									</dd>
								</div>
							);
						})}
					</dl>
				)}
				{busy && <p className="settings__note">Settings change between turns. Clio is working right now.</p>}

				<ApprovalNotificationSetting enabled={state.desktopNotifications} onChange={onNotificationsChange} />

				{open !== null && (
					<section className="settings__targets" aria-labelledby="settings-targets-title">
						<div className="settings__section-heading">
							<div>
								<div className="eyebrow">ROUTING</div>
								<h3 id="settings-targets-title">Configured targets</h3>
							</div>
							<p>Health is a point-in-time probe, never an assumed green light.</p>
						</div>
						{open.clio.capabilities?.targets !== true
							? <p className="settings__unavailable">This Clio does not expose targets over ACP.</p>
							: targets === null
							? (
								<button
									type="button"
									className="button button--quiet"
									onClick={() => actions.listTargets(open.project.id)}
								>
									Load targets
								</button>
							)
							: targets.length === 0
							? <p className="settings__note">Clio reports no configured targets.</p>
							: (
								<ul className="target-list">
									{targets.map((target) => (
										<TargetRow key={target.id} target={target} projectId={open.project.id} actions={actions} />
									))}
								</ul>
							)}
						{open.targetsTruncated && (
							<p className="settings__note">
								This list is shortened; Clio has more targets or models than are shown.
							</p>
						)}
						{targets !== null && targets.length > 0 && (
							<p className="settings__note">A target's health is shown only after you probe it.</p>
						)}
					</section>
				)}
				<p className="settings__note">{state.securityNote}</p>
			</div>
		</Modal>
	);
}

function FileOperationModal({
	dialog,
	open,
	selectedNode,
	onClose,
	actions,
}: {
	dialog: Exclude<FileDialog, null>;
	open: OpenWorkspaceState;
	selectedNode: WireTreeNode | null;
	onClose(): void;
	actions: WorkbenchActions;
}) {
	const [name, setName] = useState(selectedNode?.name ?? "");
	const [destinationParent, setDestinationParent] = useState(
		parentPath(selectedNode?.path.segments ?? []).join("/"),
	);
	const selectedParent = selectedNode?.kind === "directory"
		? selectedNode.path.segments
		: parentPath(selectedNode?.path.segments ?? []);
	const parentLabel = selectedParent.length ? selectedParent.join("/") : "/";
	function submit(event: FormEvent) {
		event.preventDefault();
		if (dialog === "delete") {
			if (selectedNode) actions.prepareDelete(open.project.id, selectedNode.path.segments, selectedNode.nodeVersion);
		} else if (dialog === "move") {
			if (!selectedNode || !name.trim()) return;
			actions.moveNode(
				open.project.id,
				selectedNode.path.segments,
				{ parent: destinationParent.split("/").filter(Boolean), name: name.trim() },
				selectedNode.nodeVersion,
			);
		} else {
			if (!name.trim()) return;
			actions.createNode(open.project.id, selectedParent, name.trim(), dialog === "create-file" ? "file" : "folder");
		}
		onClose();
	}
	const title = dialog === "create-file"
		? "Create empty file"
		: dialog === "create-folder"
		? "Create folder"
		: dialog === "move"
		? "Rename or move"
		: "Prepare confirmed delete";
	return (
		<Modal title={title} eyebrow={`PROJECT SCOPE · ${open.project.displayName.toUpperCase()}`} onClose={onClose}>
			<form className="modal-form" onSubmit={submit}>
				{dialog === "delete"
					? (
						<>
							<p>
								Inspect <code>{selectedNode ? formatProjectPath(selectedNode.path) : "no selection"}</code>{" "}
								before requesting a one-use confirmation challenge.
							</p>
							<p className="modal-form__warning">
								Workbench deletes files and empty folders only. Symlinks and recursive deletion are blocked.
							</p>
						</>
					)
					: (
						<>
							{dialog === "move" && (
								<label>
									<span>Destination folder (project relative)</span>
									<input
										value={destinationParent}
										onChange={(event) => setDestinationParent(event.target.value)}
										placeholder="analysis/reports"
									/>
								</label>
							)}
							<label>
								<span>{dialog === "move" ? "Destination name" : "Name"}</span>
								<input
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder={dialog === "create-file" ? "notes.md" : "results"}
									pattern={NON_BLANK_PATTERN}
									title="Enter at least one non-space character."
									required
								/>
							</label>
							<p className="modal-form__note">
								Destination parent: <code>{dialog === "move" ? destinationParent || "/" : parentLabel}</code>{" "}
								Existing entries are never overwritten.
							</p>
						</>
					)}
				<div className="modal__actions">
					<button type="button" className="button button--quiet" onClick={onClose}>Cancel</button>
					<button
						type="submit"
						className={`button ${dialog === "delete" ? "button--danger" : "button--primary"}`}
						disabled={dialog === "delete" && !selectedNode}
					>
						{dialog === "delete" ? "Inspect and prepare" : "Apply in project"}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function DeleteConfirmationModal({
	challenge,
	projectId,
	onClose,
	actions,
}: {
	challenge: WireDeleteChallenge;
	projectId: string;
	onClose(): void;
	actions: WorkbenchActions;
}) {
	return (
		<Modal title={`Delete ${challenge.targetKind}`} eyebrow="ONE-USE CONFIRMATION" onClose={onClose}>
			<div className="delete-confirmation">
				<div className="delete-confirmation__target">
					<span>TARGET</span>
					<code>{challenge.displayPath}</code>
				</div>
				<p>The host bound this challenge to the exact project, path, and inspected node fingerprint.</p>
				<dl>
					<div>
						<dt>Expires</dt>
						<dd>{new Date(challenge.expiresAt).toLocaleTimeString()}</dd>
					</div>
					<div>
						<dt>Recovery</dt>
						<dd>Not available for this controlled item</dd>
					</div>
				</dl>
				<div className="modal__actions">
					<button type="button" className="button button--quiet" onClick={onClose}>Keep item</button>
					<button
						type="button"
						className="button button--danger"
						onClick={() => {
							actions.confirmDelete(projectId, challenge.confirmationId);
							onClose();
						}}
					>
						Delete exactly this item
					</button>
				</div>
			</div>
		</Modal>
	);
}

function BottomStatus({ state, actions, obscured, approvalEscalated }: {
	state: AppState;
	actions: WorkbenchActions;
	obscured: boolean;
	approvalEscalated: boolean;
}) {
	const open = state.open;
	const session = open?.clio.session ?? null;
	const activeTurn = open?.projection.activeTurn ?? null;
	const elapsed = useElapsedSeconds(activeTurn?.startedAt ?? null);
	const phase = open?.clio.phase ?? "closed";
	const operation = open === null
		? "no project"
		: phase === "awaiting-approval"
		? "awaiting approval"
		: phase === "cancelling"
		? "stopping"
		: activeTurn
		? `running ${formatDuration(elapsed)}`
		: "idle";
	const autonomyEditable = open !== null && session !== null && open.clio.capabilities?.autonomy === true &&
		!isPromptBlocked(open);
	// Settings describe what Clio would bind next, which is a different fact from
	// what the bound session is running on. Only show it when the two disagree.
	//
	// The two facts reach the bound session on different schedules and must never
	// share a label. Clio reads target and model routing at prompt time, so a
	// patch to either lands on this session's next turn. Autonomy is pinned at
	// session/new for the life of the process, so a patched global autonomy
	// reaches only the next session and the bound one moves through
	// clio-coder/session/autonomy instead.
	const nextTarget = open?.settings?.settings["orchestrator.target"] ?? null;
	const nextModel = open?.settings?.settings["orchestrator.model"] ?? null;
	const nextTurnDiffers = open?.settings != null && session !== null &&
		(nextTarget !== session.target || nextModel !== session.model);
	const settingsAutonomy = open?.settings?.settings["autonomy"] ?? null;
	const nextSessionAutonomy = settingsAutonomy !== null && isAutonomyLevel(settingsAutonomy) ? settingsAutonomy : null;
	const nextSessionDiffers = session !== null && nextSessionAutonomy !== null &&
		nextSessionAutonomy !== session.autonomy;
	return (
		<footer
			className="status-bar"
			aria-label="Workbench status"
			aria-hidden={obscured ? true : undefined}
			inert={obscured}
		>
			<div className="status-bar__connection">
				<StatusMark tone={state.connection === "connected" ? "success" : "error"} label={state.connection} />
				<span>{state.mode} host · 127.0.0.1 · token bound</span>
			</div>
			<div className="status-bar__project">
				<span>Project</span>
				<strong>{open === null ? "none" : open.project.displayName}</strong>
			</div>
			<div className="status-bar__session">
				<span>Session bound to</span>
				<strong>
					{session === null ? "no session" : `${session.target ?? "unselected"} · ${session.model ?? "unselected"}`}
				</strong>
			</div>
			{nextTurnDiffers && (
				<div className="status-bar__next-turn">
					<span>Next turn</span>
					<strong>{`${nextTarget ?? "unselected"} · ${nextModel ?? "unselected"}`}</strong>
				</div>
			)}
			{nextSessionDiffers && nextSessionAutonomy !== null && (
				<div className="status-bar__next-session">
					<span>Next session</span>
					<strong>{`${AUTONOMY_LABELS[nextSessionAutonomy]} autonomy`}</strong>
				</div>
			)}
			<div className="status-bar__autonomy">
				<span>Autonomy</span>
				{session === null ? <strong>unbound</strong> : (
					<>
						<select
							aria-label="Session autonomy"
							value={session.autonomy}
							disabled={!autonomyEditable}
							onChange={(event) =>
								open && actions.setAutonomy(open.project.id, event.target.value as WireAutonomyLevel)}
						>
							{(Object.keys(AUTONOMY_LABELS) as WireAutonomyLevel[]).map((level) => (
								<option value={level} key={level}>{AUTONOMY_LABELS[level]}</option>
							))}
						</select>
						<small>
							{session.autonomySource === "session" ? "set for this session" : "inherited from settings"}
						</small>
					</>
				)}
			</div>
			<div
				className={`status-bar__operation${activeTurn !== null ? " is-active" : ""}${
					approvalEscalated ? " is-escalated" : ""
				}`}
			>
				<span>Operation</span>
				<strong>{approvalEscalated ? `${operation} · escalated` : operation}</strong>
			</div>
		</footer>
	);
}

export function WorkbenchView({ state, dispatch, actions }: WorkbenchViewProps) {
	const open = state.open;
	const leftRailIsDrawer = useMediaQuery("(max-width: 790px)");
	const evidenceRailIsDrawer = useMediaQuery("(max-width: 1180px)");
	const [fileDialog, setFileDialog] = useState<FileDialog>(null);
	const [selectedNode, setSelectedNode] = useState<WireTreeNode | null>(null);
	const [sessionToDelete, setSessionToDelete] = useState<WireSessionSummary | null>(null);
	const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false);
	const previousLeftDrawerOpen = useRef(state.leftDrawerOpen);
	const previousEvidenceDrawerOpen = useRef(evidenceDrawerOpen);
	const pendingPermission = open?.projection.pendingPermission ?? null;
	const activeTurn = open?.projection.activeTurn ?? null;
	// One clock for the whole shell, so the banner, the tool cards, and the status
	// bar can never disagree about how long something has been waiting.
	const nowMs = useNow(activeTurn !== null || pendingPermission !== null);
	const approvalEscalated = pendingPermission !== null && nowMs >= Date.parse(pendingPermission.escalateAt);
	const escalatedSeconds = pendingPermission === null ? 0 : Math.max(
		0,
		Math.floor((Date.parse(pendingPermission.escalateAt) - Date.parse(pendingPermission.requestedAt)) / 1_000),
	);
	const modalIsOpen = fileDialog !== null || Boolean(open?.deleteChallenge) || state.browse !== null ||
		state.settingsOpen || sessionToDelete !== null;
	const leftDrawerObscures = leftRailIsDrawer && state.leftDrawerOpen;
	const evidenceDrawerObscures = evidenceRailIsDrawer && evidenceDrawerOpen;
	const backgroundObscured = modalIsOpen || leftDrawerObscures || evidenceDrawerObscures;

	useEffect(() => {
		setFileDialog(null);
		setSelectedNode(null);
		setSessionToDelete(null);
		setEvidenceDrawerOpen(false);
	}, [open?.project.id]);

	useEffect(() => {
		if (!evidenceRailIsDrawer) setEvidenceDrawerOpen(false);
	}, [evidenceRailIsDrawer]);

	useEffect(() => {
		if (leftRailIsDrawer && state.leftDrawerOpen) {
			document.querySelector<HTMLButtonElement>(".left-rail__close")?.focus();
		} else if (leftRailIsDrawer && previousLeftDrawerOpen.current) {
			document.querySelector<HTMLButtonElement>(".mobile-controls button")?.focus();
		}
		previousLeftDrawerOpen.current = state.leftDrawerOpen;
	}, [leftRailIsDrawer, state.leftDrawerOpen]);

	useEffect(() => {
		if (evidenceRailIsDrawer && evidenceDrawerOpen) {
			document.querySelector<HTMLButtonElement>(".evidence-rail__close")?.focus();
		} else if (evidenceRailIsDrawer && previousEvidenceDrawerOpen.current) {
			document.querySelector<HTMLButtonElement>(".mobile-controls--evidence button")?.focus();
		}
		previousEvidenceDrawerOpen.current = evidenceDrawerOpen;
	}, [evidenceDrawerOpen, evidenceRailIsDrawer]);

	useEffect(() => {
		if (modalIsOpen || !leftDrawerObscures) return;
		const constrainDrawerFocus = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				dispatch({ type: "drawer.left", open: false });
				return;
			}
			const drawer = document.querySelector<HTMLElement>("#project-rail");
			if (drawer) containTabKey(event, drawer);
		};
		document.addEventListener("keydown", constrainDrawerFocus);
		return () => document.removeEventListener("keydown", constrainDrawerFocus);
	}, [dispatch, leftDrawerObscures, modalIsOpen]);

	useEffect(() => {
		if (modalIsOpen || !evidenceDrawerObscures) return;
		const constrainDrawerFocus = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				setEvidenceDrawerOpen(false);
				return;
			}
			const drawer = document.querySelector<HTMLElement>("#evidence-rail");
			if (drawer) containTabKey(event, drawer);
		};
		document.addEventListener("keydown", constrainDrawerFocus);
		return () => document.removeEventListener("keydown", constrainDrawerFocus);
	}, [evidenceDrawerObscures, modalIsOpen]);

	// The approval is the one thing the operator must not miss.
	useEffect(() => {
		const previous = document.title;
		document.title = pendingPermission === null ? "Clio Workbench" : "● Approval needed — Clio Workbench";
		return () => {
			document.title = previous;
		};
	}, [pendingPermission?.permissionId ?? null]);

	// Alt+A and Alt+R answer the card from wherever the operator is. Suppressed
	// while a modal is up, so a dialog's own controls stay unambiguous.
	useEffect(() => {
		if (pendingPermission === null || activeTurn === null || open === null || modalIsOpen) return;
		const answer = (event: globalThis.KeyboardEvent) => {
			if (!event.altKey || event.ctrlKey || event.metaKey) return;
			const key = event.key.toLowerCase();
			if (key !== "a" && key !== "r") return;
			event.preventDefault();
			actions.resolvePermission(
				open.project.id,
				activeTurn.turnId,
				pendingPermission.permissionId,
				key === "a" ? "allow-once" : "reject",
			);
		};
		document.addEventListener("keydown", answer);
		return () => document.removeEventListener("keydown", answer);
	}, [actions, activeTurn?.turnId, modalIsOpen, open?.project.id, pendingPermission?.permissionId]);

	// One desktop notification per card, and only if permission was already
	// granted. Nothing here ever asks for it; the settings toggle does that.
	useEffect(() => {
		if (pendingPermission === null || !state.desktopNotifications) return;
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		try {
			// Title only. A path in a notification would leave the project boundary.
			const posted = new Notification("Clio Workbench: approval needed", { body: pendingPermission.title });
			return () => posted.close();
		} catch {
			// A browser that refuses to construct one is not a Workbench failure.
		}
	}, [pendingPermission?.permissionId ?? null, state.desktopNotifications]);

	if (state.boot === "loading") return <LoadingScreen />;
	if (state.boot === "failed") return <FailureScreen message={state.bootError ?? "Workbench could not start."} />;

	return (
		<div className="workbench-shell">
			<div className="ambient-grid" aria-hidden="true" />
			<div className="sr-only" aria-live="assertive" aria-atomic="true">{state.announcement}</div>
			<div className="sr-only" aria-live="assertive" aria-atomic="true">
				{approvalEscalated ? `An approval has been waiting for ${escalatedSeconds} seconds.` : ""}
			</div>
			<div
				className={`drawer-scrim${leftDrawerObscures || evidenceDrawerObscures ? " is-visible" : ""}`}
				onClick={() => {
					dispatch({ type: "drawer.left", open: false });
					setEvidenceDrawerOpen(false);
				}}
				aria-hidden="true"
			/>
			<ProjectRail
				state={state}
				dispatch={dispatch}
				actions={actions}
				selectedNode={selectedNode}
				onSelectNode={setSelectedNode}
				onFileDialog={setFileDialog}
				onDeleteSession={setSessionToDelete}
				isDrawer={leftRailIsDrawer}
				obscured={modalIsOpen || evidenceDrawerObscures}
			/>
			<ConversationCanvas
				state={state}
				dispatch={dispatch}
				actions={actions}
				obscured={backgroundObscured}
				nowMs={nowMs}
				inspectorOpen={evidenceDrawerOpen}
				onInspectorToggle={() => setEvidenceDrawerOpen((current) => !current)}
			/>
			<EvidenceRail
				state={state}
				nowMs={nowMs}
				isDrawer={evidenceRailIsDrawer}
				drawerOpen={evidenceDrawerOpen}
				onClose={() => setEvidenceDrawerOpen(false)}
				obscured={modalIsOpen || leftDrawerObscures}
			/>
			<BottomStatus
				state={state}
				actions={actions}
				obscured={backgroundObscured}
				approvalEscalated={approvalEscalated}
			/>
			{state.notice && (
				<div className={`app-notice app-notice--${state.notice.tone}`} role="alert">
					<span aria-hidden="true">!</span>
					<p>{state.notice.message}</p>
					<button type="button" className="icon-button" onClick={() => dispatch({ type: "notice.dismissed" })}>
						<Glyph>×</Glyph>
						<span className="sr-only">Dismiss notification</span>
					</button>
				</div>
			)}
			{state.browse !== null && (
				<BrowseModal
					state={state}
					actions={actions}
					onClose={() => dispatch({ type: "browse.dismissed" })}
				/>
			)}
			{state.settingsOpen && (
				<SettingsModal
					state={state}
					actions={actions}
					dispatch={dispatch}
					onClose={() => dispatch({ type: "settings.opened", open: false })}
				/>
			)}
			{sessionToDelete !== null && open && (
				<SessionDeleteModal
					session={sessionToDelete}
					projectId={open.project.id}
					actions={actions}
					onClose={() => setSessionToDelete(null)}
				/>
			)}
			{fileDialog && open && (
				<FileOperationModal
					dialog={fileDialog}
					open={open}
					selectedNode={selectedNode}
					onClose={() => setFileDialog(null)}
					actions={actions}
				/>
			)}
			{open?.deleteChallenge && (
				<DeleteConfirmationModal
					challenge={open.deleteChallenge}
					projectId={open.project.id}
					onClose={() => actions.refreshTree(open.project.id)}
					actions={actions}
				/>
			)}
		</div>
	);
}

export default WorkbenchView;
