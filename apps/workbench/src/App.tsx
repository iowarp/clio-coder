import { useEffect, useId, useRef, useState } from "react";
import type { Dispatch, FormEvent, KeyboardEvent, ReactNode } from "react";
import type { FakeScenario, WireEngineKind, WireEnginePhase, WireEngineSource } from "./protocol.ts";
import {
	type AppAction,
	type AppState,
	type DeleteChallenge,
	formatProjectPath,
	type ProjectPath,
	type ProjectWorkspaceState,
	selectedWorkspace,
	type TimelineItem,
	type TreeNode,
} from "./state.ts";

export interface WorkbenchActions {
	selectEngine(projectId: string, kind: WireEngineKind): void;
	probeEngine(projectId: string): void;
	startTurn(projectId: string, prompt: string, fakeScenario?: FakeScenario): void;
	cancelTurn(projectId: string, turnId: string): void;
	resolvePermission(
		projectId: string,
		turnId: string,
		permissionId: string,
		decision: "allow-once" | "reject",
	): void;
	selectProject(projectId: string): void;
	createProject(displayName: string, directoryName: string): void;
	registerProject(relativeRoot: readonly string[], displayName?: string): void;
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
}

interface WorkbenchViewProps {
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
}

type ProjectDialog = "create" | "register" | null;
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

const ENGINE_PHASE_PRESENTATION: Record<WireEnginePhase, { label: string; tone: string }> = {
	ready: { label: "Ready", tone: "success" },
	unprobed: { label: "Readiness not checked", tone: "warning" },
	probing: { label: "Checking readiness", tone: "info" },
	unavailable: { label: "Unavailable", tone: "warning" },
	starting: { label: "Starting Clio", tone: "info" },
	connected: { label: "Clio connected", tone: "success" },
	running: { label: "Running", tone: "action" },
	"awaiting-approval": { label: "Awaiting permission", tone: "warning" },
	cancelling: { label: "Cancelling", tone: "warning" },
	failed: { label: "Failed", tone: "error" },
};

const ENGINE_NAMES: Record<WireEngineKind, string> = {
	fake: "Fake",
	"clio-acp": "Clio",
};

function isEngineOperationActive(phase: WireEnginePhase): boolean {
	return phase === "starting" || phase === "connected" || phase === "running" ||
		phase === "awaiting-approval" || phase === "cancelling";
}

const SOURCE_LABELS: Record<WireEngineSource, string> = {
	"simulated-by-workbench": "Simulated by Workbench",
	"reported-by-clio": "Reported by Clio",
	"observed-on-acp": "Observed on ACP",
	"observed-by-workbench": "Observed by Workbench",
	"independently-verified": "Independently verified",
};

function sourceLabel(source: WireEngineSource | undefined): string | null {
	return source ? SOURCE_LABELS[source] : null;
}

function formatPermissionLocation(path: { readonly segments: readonly string[] }): string {
	return path.segments.length > 0 ? path.segments.join("/") : "unavailable";
}

function formatTimeLabel(value: string): string {
	if (value === "now") return value;
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
			<p>Calibrating the localhost instrument…</p>
			<div className="boot-screen__rule" />
			<small>Engine checks are explicit and never alter Clio configuration.</small>
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

function pathKey(path: ProjectPath | readonly string[]): string {
	const segments = "segments" in path ? path.segments : path;
	return segments.join("\u001f");
}

function parentPath(path: readonly string[]): string[] {
	return path.slice(0, -1);
}

function TreeBranch({
	nodes,
	selected,
	onSelect,
	level = 1,
}: {
	nodes: TreeNode[];
	selected: string | null;
	onSelect(node: TreeNode): void;
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

function ProjectRail({
	state,
	workspace,
	dispatch,
	onProjectDialog,
	onSelectProject,
	selectedNode,
	onSelectNode,
	onFileDialog,
	onRefresh,
	slotActive,
	isDrawer,
	obscured,
}: {
	state: AppState;
	workspace: ProjectWorkspaceState;
	dispatch: Dispatch<AppAction>;
	onProjectDialog(dialog: ProjectDialog): void;
	onSelectProject(projectId: string): void;
	selectedNode: TreeNode | null;
	onSelectNode(node: TreeNode): void;
	onFileDialog(dialog: FileDialog): void;
	onRefresh(): void;
	slotActive: boolean;
	isDrawer: boolean;
	obscured: boolean;
}) {
	const projects = Object.values(state.projects);
	const unavailable = obscured || (isDrawer && !state.leftDrawerOpen);
	return (
		<aside
			id="project-rail"
			className={`left-rail instrument-panel${state.leftDrawerOpen ? " is-open" : ""}`}
			aria-label="Projects, files, and sessions"
			aria-hidden={unavailable ? true : undefined}
			inert={unavailable}
		>
			<div className="left-rail__brand">
				<BrandLockup />
				<div className="left-rail__brand-actions">
					<StatusMark
						tone={state.connection === "connected" ? "success" : state.connection === "connecting" ? "info" : "error"}
						label={state.connection === "connected" ? "Local channel" : state.connection}
					/>
					<button
						type="button"
						className="icon-button left-rail__close"
						onClick={() => dispatch({ type: "drawer.left", open: false })}
					>
						<Glyph>×</Glyph>
						<span className="sr-only">Close projects and files</span>
					</button>
				</div>
			</div>

			<section className="rail-section rail-section--projects" aria-labelledby="project-library-title">
				<PanelHeading
					eyebrow="LIBRARY"
					title="Projects"
					headingId="project-library-title"
					action={
						<div className="segmented-actions" aria-label="Project actions">
							<button
								type="button"
								className="icon-button"
								onClick={() => onProjectDialog("register")}
								disabled={slotActive}
								title={slotActive ? "Cancel the active turn before changing projects." : undefined}
							>
								<Glyph>↳</Glyph>
								<span className="sr-only">Register existing sandbox project</span>
							</button>
							<button
								type="button"
								className="icon-button"
								onClick={() => onProjectDialog("create")}
								disabled={slotActive}
								title={slotActive ? "Cancel the active turn before changing projects." : undefined}
							>
								<Glyph>＋</Glyph>
								<span className="sr-only">Create sandbox project</span>
							</button>
						</div>
					}
				/>
				<div className="project-list">
					{projects.map(({ project, engine }) => {
						const phase = ENGINE_PHASE_PRESENTATION[engine.phase];
						const selected = project.id === state.selectedProjectId;
						const switchBlocked = slotActive && !selected;
						return (
							<button
								type="button"
								key={project.id}
								className={`project-card${selected ? " is-selected" : ""}`}
								onClick={() => !selected && onSelectProject(project.id)}
								aria-pressed={selected}
								aria-disabled={switchBlocked || undefined}
								disabled={switchBlocked}
								title={switchBlocked ? "Cancel the active turn before switching projects." : undefined}
							>
								<span className="project-card__ordinal">
									{String(projects.findIndex((item) => item.project.id === project.id) + 1).padStart(2, "0")}
								</span>
								<span className="project-card__body">
									<strong>{project.displayName}</strong>
									<code>{project.identity.displayPath}</code>
								</span>
								<span className={`project-card__state project-card__state--${phase.tone}`}>
									<span aria-hidden="true">
										{engine.phase === "running" || engine.phase === "cancelling" ? "◆" : "●"}
									</span>
									<span className="sr-only">
										{ENGINE_NAMES[engine.kind]} engine; {phase.label}
									</span>
								</span>
							</button>
						);
					})}
				</div>
				{slotActive && (
					<p className="project-lock-note">
						Cancel the active turn before switching projects or engines.
					</p>
				)}
			</section>

			<section className="rail-section rail-section--files" aria-labelledby="files-title">
				<PanelHeading
					eyebrow="PROJECT SCOPE"
					title="Files"
					headingId="files-title"
					action={
						<button type="button" className="icon-button" onClick={onRefresh} title="Refresh project tree">
							<Glyph>↻</Glyph>
							<span className="sr-only">Refresh project tree</span>
						</button>
					}
				/>
				<div className="file-toolbar" aria-label="File operations">
					<button type="button" onClick={() => onFileDialog("create-file")}>
						<Glyph>＋≡</Glyph> File
					</button>
					<button type="button" onClick={() => onFileDialog("create-folder")}>
						<Glyph>＋▱</Glyph> Folder
					</button>
					<button type="button" onClick={() => onFileDialog("move")} disabled={!selectedNode?.operable}>
						<Glyph>↱</Glyph> Move
					</button>
					<button type="button" onClick={() => onFileDialog("delete")} disabled={!selectedNode?.operable}>
						<Glyph>×</Glyph> Delete
					</button>
				</div>
				<div className="tree-viewport">
					{workspace.tree.length > 0
						? (
							<TreeBranch
								nodes={workspace.tree}
								selected={selectedNode ? pathKey(selectedNode.path) : null}
								onSelect={onSelectNode}
							/>
						)
						: (
							<div className="compact-empty">
								<Glyph>∅</Glyph>
								<p>This project has no visible files yet.</p>
							</div>
						)}
					{workspace.treeTruncated && <p className="tree-note">Tree capped at the project safety limit.</p>}
				</div>
			</section>

			<section className="rail-section rail-section--sessions" aria-labelledby="sessions-title">
				<PanelHeading
					eyebrow={workspace.engine.kind === "clio-acp" ? "CURRENT PROCESS · NO RESUME" : "PROJECT HISTORY"}
					title="Sessions"
					headingId="sessions-title"
				/>
				<div className="session-list">
					{workspace.sessions.length > 0
						? (
							workspace.sessions.map((session) => (
								<article className="session-row" key={session.id}>
									<span className={`session-row__mark session-row__mark--${session.status}`} aria-hidden="true" />
									<span>
										<strong>{session.label}</strong>
										<small>{session.preview}</small>
									</span>
									<time>{formatTimeLabel(session.updatedAt)}</time>
								</article>
							))
						)
						: <p className="rail-empty">No completed session has been recorded for this project.</p>}
				</div>
				{workspace.engine.kind === "clio-acp" && (
					<p className="tree-note">ACP session load, replay, and resume are unavailable.</p>
				)}
			</section>
		</aside>
	);
}

function ReadinessStrip({
	workspace,
	onSelect,
	onProbe,
	locked,
}: {
	workspace: ProjectWorkspaceState;
	onSelect(kind: WireEngineKind): void;
	onProbe(): void;
	locked: boolean;
}) {
	const { engine } = workspace;
	const phase = ENGINE_PHASE_PRESENTATION[engine.phase];
	const isClio = engine.kind === "clio-acp";
	const controlsLocked = locked || engine.phase === "probing";
	const detail = isClio
		? "Workbench sends this prompt only through the configured Clio target. That target may be remote."
		: "Fake mode makes no provider request. Its activity is deterministic and simulated by Workbench.";
	return (
		<section className={`readiness-strip readiness-strip--${phase.tone}`} aria-labelledby="readiness-title">
			<div className="readiness-strip__calibration" aria-hidden="true">
				<span>0</span>
				<i />
				<i />
				<i />
				<i />
				<span>1</span>
			</div>
			<div className="readiness-strip__body">
				<div className="readiness-strip__summary">
					<div className="eyebrow" id="readiness-title">
						ENGINE READINESS · {ENGINE_NAMES[engine.kind].toUpperCase()}
					</div>
					<strong>{phase.label}</strong>
					<p>{detail}</p>
				</div>
				<div className="readiness-strip__controls">
					<label className="scenario-select">
						<span>Project engine</span>
						<select
							value={engine.kind}
							onChange={(event) => onSelect(event.target.value as WireEngineKind)}
							disabled={controlsLocked}
							title={engine.phase === "probing"
								? "Wait for the readiness check before changing engines."
								: locked
								? "Cancel the active turn before changing engines."
								: undefined}
						>
							<option value="fake">Fake</option>
							<option value="clio-acp">Clio</option>
						</select>
					</label>
					{isClio && (
						<button
							type="button"
							className="button button--primary readiness-strip__probe"
							onClick={onProbe}
							disabled={locked || engine.phase === "probing"}
							title={locked ? "Cancel the active turn before checking readiness." : undefined}
						>
							{engine.phase === "probing" ? "Checking…" : "Check Clio readiness"}
						</button>
					)}
				</div>
			</div>
			{isClio && (
				<ul className="readiness-strip__facts" aria-label="Clio readiness facts">
					{engine.facts.map((fact) => (
						<li key={fact.key} title={`${fact.label}: ${fact.detail} · ${SOURCE_LABELS[fact.source]}`}>
							<span>{fact.label}</span>
							<strong className={`readiness-fact readiness-fact--${fact.state}`}>{fact.state}</strong>
							<small>{SOURCE_LABELS[fact.source]}</small>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function TimelineCard({ item }: { item: TimelineItem }) {
	const labels: Record<TimelineItem["kind"], string> = {
		request: "REQUEST",
		narrative: "NARRATIVE",
		agent: "AGENT",
		tool: "TOOL / ACTION",
		change: "CHANGE",
		approval: "PERMISSION",
		evidence: "CHECK",
		outcome: "OUTCOME",
		failure: "FAILURE",
	};
	const provenance = sourceLabel(item.source);
	return (
		<article className={`timeline-card timeline-card--${item.kind} timeline-card--${item.status}`}>
			<div className="timeline-card__meta">
				<span>{labels[item.kind]}</span>
				{provenance && <span className="timeline-card__source">{provenance}</span>}
				<time>{item.timeLabel}</time>
				{item.sequence !== undefined && <code>#{String(item.sequence).padStart(3, "0")}</code>}
			</div>
			<h3>{item.title}</h3>
			<p>{item.summary}</p>
			{item.detail && <pre className="timeline-card__detail">{item.detail}</pre>}
			<div className="timeline-card__status">
				<StatusMark
					tone={item.status === "failed"
						? "error"
						: item.status === "active"
						? "action"
						: item.status === "waiting"
						? "warning"
						: "success"}
					label={item.status}
				/>
			</div>
		</article>
	);
}

function PermissionCard({
	workspace,
	onResolve,
}: {
	workspace: ProjectWorkspaceState;
	onResolve(decision: "allow-once" | "reject"): void;
}) {
	const permission = workspace.pendingPermission;
	if (!permission) return null;
	const isSimulated = permission.source === "simulated-by-workbench";
	const locations = permission.locations.length > 0
		? permission.locations.map(formatPermissionLocation).join(", ")
		: "Unavailable";
	return (
		<section className="approval-card" aria-labelledby="permission-title">
			<div className="approval-card__signal" aria-hidden="true">!</div>
			<div className="approval-card__body">
				<div className="eyebrow">PERMISSION NEEDED · ONE USE</div>
				<h3 id="permission-title">{permission.title}</h3>
				{isSimulated
					? (
						<p>
							The Workbench simulation is demonstrating a bounded <strong>{permission.kind}</strong>{" "}
							permission boundary. No Clio or provider request is involved.
						</p>
					)
					: (
						<p>
							Clio requested permission for a bounded <strong>{permission.kind}</strong> action.
						</p>
					)}
				<dl>
					<div>
						<dt>Provenance</dt>
						<dd>{SOURCE_LABELS[permission.source]}</dd>
					</div>
					<div>
						<dt>Project-relative location</dt>
						<dd>{locations}</dd>
					</div>
					<div>
						<dt>Expires</dt>
						<dd>{new Date(permission.expiresAt).toLocaleTimeString()}</dd>
					</div>
					<div>
						<dt>Consequence</dt>
						<dd>Allow once applies only to this exact action. Reject denies it without granting future authority.</dd>
					</div>
				</dl>
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

function ConversationCanvas({
	workspace,
	state,
	dispatch,
	actions,
	engineLocked,
	obscured,
}: {
	workspace: ProjectWorkspaceState;
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
	engineLocked: boolean;
	obscured: boolean;
}) {
	const [draft, setDraft] = useState(
		"Audit the convergence study, preserve the raw data, and report what the checks actually prove.",
	);
	const [scenario, setScenario] = useState<"complete" | "failure">("complete");
	const timelineEnd = useRef<HTMLDivElement>(null);
	const isClio = workspace.engine.kind === "clio-acp";
	const isBusy = workspace.activeTurnId !== null || workspace.pendingPermission !== null ||
		isEngineOperationActive(workspace.engine.phase);
	const canStart = !engineLocked && !isBusy && (!isClio || workspace.engine.phase === "ready");

	useEffect(() => {
		if (isBusy && workspace.timeline.length > 0) timelineEnd.current?.scrollIntoView({ block: "nearest" });
	}, [isBusy, workspace.timeline.length]);

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!canStart || draft.trim().length === 0) return;
		actions.startTurn(workspace.project.id, draft.trim(), isClio ? undefined : scenario);
	}

	function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			event.currentTarget.form?.requestSubmit();
		}
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
						onClick={() => dispatch({ type: "drawer.left", open: true })}
						aria-controls="project-rail"
						aria-expanded={state.leftDrawerOpen}
					>
						<Glyph>☷</Glyph>
						<span className="sr-only">Open projects and files</span>
					</button>
				</div>
				<div className="conversation__identity">
					<div className="eyebrow">ACTIVE PROJECT · ONE ENGINE SLOT</div>
					<h1>{workspace.project.displayName}</h1>
					<code>{workspace.project.identity.displayPath}</code>
				</div>
				<div className="conversation__telemetry">
					<div>
						<span>HOST</span>
						<strong>{state.mode}</strong>
					</div>
					<div>
						<span>ENGINE</span>
						<strong>{ENGINE_NAMES[workspace.engine.kind]} · {workspace.engine.phase}</strong>
					</div>
					<div>
						<span>STREAM</span>
						<strong>{workspace.lastSequence || "—"}</strong>
					</div>
				</div>
				<div className="mobile-controls">
					<button
						type="button"
						className="icon-button"
						onClick={() => dispatch({ type: "drawer.right", open: true })}
						aria-controls="activity-rail"
						aria-expanded={state.rightDrawerOpen}
					>
						<Glyph>◫</Glyph>
						<span className="sr-only">Open activity and evidence</span>
					</button>
				</div>
			</header>

			<div className="conversation__scroll">
				<ReadinessStrip
					workspace={workspace}
					onSelect={(kind) => actions.selectEngine(workspace.project.id, kind)}
					onProbe={() => actions.probeEngine(workspace.project.id)}
					locked={engineLocked}
				/>
				<section className="field-note" aria-labelledby="field-note-title">
					<div className="field-note__folio">FIELD NOTE · {workspace.project.displayName.toUpperCase()} / 01</div>
					<div>
						<div className="eyebrow">LOCALHOST-FIRST INSTRUMENT</div>
						<h2 id="field-note-title">A visible chain from request to evidence</h2>
						{isClio
							? (
								<p>
									This timeline shows bounded facts observed through ACP. Clio-reported actions remain distinct from
									Workbench-observed or independently verified evidence.
								</p>
							)
							: (
								<p>
									This session uses a deterministic fake stream. It demonstrates ordering, activity, permission,
									cancellation, changes, and checks without starting Clio or presenting simulated evidence as real.
								</p>
							)}
					</div>
					<div className="field-note__stamp">
						{isClio
							? (
								<>
									CLIO<br />ACP
								</>
							)
							: (
								<>
									FAKE<br />ENGINE
								</>
							)}
					</div>
				</section>

				<section
					className="evidence-timeline"
					aria-label="Request, work, change, check, and outcome timeline"
					aria-live="polite"
				>
					<div className="evidence-timeline__axis" aria-hidden="true">
						<span>REQUEST</span>
						<span>WORK</span>
						<span>CHANGE</span>
						<span>CHECK</span>
						<span>OUTCOME</span>
					</div>
					{workspace.timeline.length === 0
						? (
							<div className="timeline-empty">
								<div className="timeline-empty__reticle" aria-hidden="true">
									<span />
									<span />
								</div>
								<h2>No activity recorded for this project</h2>
								<p>
									{isClio
										? "Check readiness, then submit the field note to start a Clio turn."
										: "Submit the field note below to run the deterministic evidence sequence."}
								</p>
							</div>
						)
						: (
							workspace.timeline.map((item) => <TimelineCard key={item.id} item={item} />)
						)}
					<PermissionCard
						workspace={workspace}
						onResolve={(decision) => {
							if (workspace.pendingPermission && workspace.activeTurnId) {
								actions.resolvePermission(
									workspace.project.id,
									workspace.activeTurnId,
									workspace.pendingPermission.permissionId,
									decision,
								);
							}
						}}
					/>
					<div ref={timelineEnd} />
				</section>
			</div>

			<form className={`composer${isBusy ? " composer--active" : ""}`} onSubmit={submit}>
				<div className="composer__mode">
					<span className="composer__mode-label">{isBusy ? "RUNNING" : "MESSAGE"}</span>
					<span>
						{isBusy
							? `${ENGINE_NAMES[workspace.engine.kind]} engine is producing ordered events`
							: isClio && workspace.engine.phase !== "ready"
							? "Check Clio readiness before starting a turn"
							: "Describe the next research objective"}
					</span>
				</div>
				<div className="composer__input-row">
					<textarea
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={onComposerKeyDown}
						disabled={isBusy}
						rows={2}
						aria-label="Research request"
						placeholder="Explain the scientific coding goal…"
					/>
					{isBusy && workspace.activeTurnId
						? (
							<button
								type="button"
								className="composer__submit composer__submit--cancel"
								onClick={() => actions.cancelTurn(workspace.project.id, workspace.activeTurnId ?? "")}
								disabled={workspace.engine.phase === "cancelling"}
							>
								<Glyph>■</Glyph>
								<span>Cancel</span>
							</button>
						)
						: (
							<button
								type="submit"
								className="composer__submit"
								disabled={draft.trim().length === 0 || !canStart}
							>
								<Glyph>↗</Glyph>
								<span>{isClio ? "Run with Clio" : "Run fake session"}</span>
							</button>
						)}
				</div>
				<div className="composer__footer">
					{!isClio && (
						<label>
							<span>Fake outcome</span>
							<select
								value={scenario}
								onChange={(event) => setScenario(event.target.value as "complete" | "failure")}
								disabled={isBusy}
							>
								<option value="complete">Complete after permission</option>
								<option value="failure">Fail with bounded diagnostic</option>
							</select>
						</label>
					)}
					<small>
						<span className="composer__shortcut">
							<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run ·
						</span>
						<span className="composer__privacy">
							{isClio
								? "Prompt goes only through the configured Clio target; that target may be remote"
								: "Fake mode makes no provider request"}
						</span>
					</small>
				</div>
			</form>
		</main>
	);
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
	return (
		<div className="metric">
			<span>{label}</span>
			<strong>{value}</strong>
			<small>{detail}</small>
		</div>
	);
}

function ActivityPanel({ workspace }: { workspace: ProjectWorkspaceState }) {
	return (
		<div className="right-panel__content">
			<section className="engine-slot">
				<div className="engine-slot__dial" aria-hidden="true">
					<span>{workspace.engine.phase === "running" ? "RUN" : workspace.engine.kind === "fake" ? "FK" : "CL"}</span>
				</div>
				<div>
					<div className="eyebrow">PROJECT ENGINE SLOT</div>
					<h3>{ENGINE_NAMES[workspace.engine.kind]} · {workspace.engine.phase}</h3>
					<p>Keyed to {workspace.project.displayName}; no other project state is attached.</p>
				</div>
			</section>
			<div className="metric-grid">
				<Metric label="AGENTS" value={String(workspace.agents.length).padStart(2, "0")} detail="this project turn" />
				<Metric label="EVENTS" value={String(workspace.lastSequence).padStart(3, "0")} detail="monotonic" />
			</div>
			<section className="right-section">
				<PanelHeading eyebrow="ENGINE ACTIVITY" title="Activity" />
				{workspace.agents.length === 0
					? (
						<div className="panel-empty">
							<Glyph>⌁</Glyph>
							<p>No agent is active for this project.</p>
						</div>
					)
					: (
						workspace.agents.map((agent) => (
							<article className="agent-card" key={agent.id}>
								<div className="agent-card__head">
									<div className="agent-card__avatar" aria-hidden="true">E1</div>
									<div>
										<h3>{agent.name}</h3>
										<StatusMark tone={agent.status === "active" ? "action" : "success"} label={agent.status} />
									</div>
								</div>
								<p>{agent.task}</p>
								<dl>
									<div>
										<dt>Provenance</dt>
										<dd>{SOURCE_LABELS[agent.source]}</dd>
									</div>
									<div>
										<dt>Elapsed</dt>
										<dd>{agent.elapsed}</dd>
									</div>
								</dl>
							</article>
						))
					)}
			</section>
			<section className="right-section safety-note">
				<div className="eyebrow">BOUNDARY NOTE</div>
				<p>
					Only one engine slot can be active. Cancel the live turn or permission before changing projects or engines.
				</p>
			</section>
		</div>
	);
}

function ChangesPanel({ workspace }: { workspace: ProjectWorkspaceState }) {
	return (
		<div className="right-panel__content">
			<section className="attribution-banner">
				<div aria-hidden="true">≠</div>
				<p>
					<strong>Attribution is explicit.</strong>{" "}
					Attributed changes below are not broad Git status; each keeps its reported or observed provenance.
				</p>
			</section>
			<section className="right-section">
				<PanelHeading eyebrow="ATTRIBUTED EVENT STREAM" title="Changes & artifacts" />
				{workspace.changes.length === 0
					? (
						<div className="panel-empty">
							<Glyph>∅</Glyph>
							<p>No attributed change has been recorded in this project state.</p>
						</div>
					)
					: workspace.changes.map((change) => (
						<article className="change-card" key={change.id}>
							<div className="change-card__path">
								<Glyph>＋</Glyph>
								<code>{change.path}</code>
							</div>
							<p>{change.summary}</p>
							<small className="provenance-label">{SOURCE_LABELS[change.source]}</small>
							<StatusMark tone="info" label={change.status} />
						</article>
					))}
			</section>
			<section className="right-section right-section--disabled">
				<div className="eyebrow">NOT AVAILABLE</div>
				<h3>Diff and reveal actions</h3>
				<p>These require validated artifact references from real ACP. No generic file reader is exposed.</p>
				<button type="button" className="button button--quiet" disabled>Open artifact</button>
			</section>
		</div>
	);
}

function EvidencePanel({ workspace }: { workspace: ProjectWorkspaceState }) {
	const independentlyVerified = workspace.evidence.some((record) => record.source === "independently-verified");
	return (
		<div className="right-panel__content">
			<section className="evidence-ledger">
				<div className="evidence-ledger__head">
					<div>
						<span>RECORD</span>
						<strong>{workspace.evidence.length || "—"}</strong>
					</div>
					<StatusMark
						tone={independentlyVerified ? "success" : workspace.evidence.length ? "info" : "neutral"}
						label={independentlyVerified
							? "independently verified"
							: workspace.evidence.length
							? "provenance recorded"
							: "not recorded"}
					/>
				</div>
				<p>
					Evidence appears only with an explicit source. Narrative or a successful terminal result never receives an
					independent verification mark by implication.
				</p>
			</section>
			<section className="right-section">
				<PanelHeading eyebrow="PROVENANCE" title="Evidence record" />
				{workspace.evidence.length === 0
					? (
						<div className="panel-empty">
							<Glyph>○</Glyph>
							<p>No checks have been observed for this project.</p>
						</div>
					)
					: workspace.evidence.map((record, index) => (
						<article className="evidence-card" key={record.id}>
							<div className="evidence-card__number">{String(index + 1).padStart(2, "0")}</div>
							<div>
								<h3>{record.label}</h3>
								<p>{record.detail}</p>
								<small className="provenance-label">{SOURCE_LABELS[record.source]}</small>
								<StatusMark
									tone={record.source === "independently-verified"
										? "success"
										: record.status === "unavailable"
										? "neutral"
										: "info"}
									label={record.status}
								/>
							</div>
						</article>
					))}
			</section>
			<section className="right-section uncertainty-card">
				<div className="eyebrow">KNOWN UNCERTAINTY</div>
				<p>
					Receipt signatures, model identity, and independent verification remain unavailable unless a separate observed
					record provides them.
				</p>
			</section>
		</div>
	);
}

function RightRail(
	{ state, workspace, dispatch, isDrawer, obscured }: {
		state: AppState;
		workspace: ProjectWorkspaceState;
		dispatch: Dispatch<AppAction>;
		isDrawer: boolean;
		obscured: boolean;
	},
) {
	const tabs = [
		{ id: "team" as const, label: "Team" },
		{ id: "changes" as const, label: "Changes", count: workspace.changes.length },
		{ id: "evidence" as const, label: "Evidence", count: workspace.evidence.length },
	];
	const unavailable = obscured || (isDrawer && !state.rightDrawerOpen);
	return (
		<aside
			id="activity-rail"
			className={`right-rail instrument-panel${state.rightDrawerOpen ? " is-open" : ""}`}
			aria-label="Activity and evidence"
			aria-hidden={unavailable ? true : undefined}
			inert={unavailable}
		>
			<div className="right-rail__header">
				<div>
					<div className="eyebrow">LIVE INSTRUMENT</div>
					<h2>Activity & evidence</h2>
				</div>
				<button
					type="button"
					className="icon-button right-rail__close"
					onClick={() => dispatch({ type: "drawer.right", open: false })}
				>
					<Glyph>×</Glyph>
					<span className="sr-only">Close activity and evidence</span>
				</button>
			</div>
			<div className="rail-tabs" aria-label="Activity views">
				{tabs.map((tab) => (
					<button
						type="button"
						aria-pressed={state.rightPanel === tab.id}
						className={state.rightPanel === tab.id ? "is-selected" : ""}
						onClick={() => dispatch({ type: "panel.selected", panel: tab.id })}
						key={tab.id}
					>
						{tab.label}
						{tab.count !== undefined && <span>{tab.count}</span>}
					</button>
				))}
			</div>
			{state.rightPanel === "team" && <ActivityPanel workspace={workspace} />}
			{state.rightPanel === "changes" && <ChangesPanel workspace={workspace} />}
			{state.rightPanel === "evidence" && <EvidencePanel workspace={workspace} />}
		</aside>
	);
}

function Modal(
	{ title, eyebrow, children, onClose }: { title: string; eyebrow: string; children: ReactNode; onClose(): void },
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
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby={headingId} ref={container} tabIndex={-1}>
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

function ProjectOperationModal({
	dialog,
	registerableFolders,
	onClose,
	actions,
}: {
	dialog: Exclude<ProjectDialog, null>;
	registerableFolders: string[];
	onClose(): void;
	actions: WorkbenchActions;
}) {
	const [displayName, setDisplayName] = useState("");
	const [directoryName, setDirectoryName] = useState("");
	const [selectedFolder, setSelectedFolder] = useState(registerableFolders[0] ?? "");
	function submit(event: FormEvent) {
		event.preventDefault();
		if (dialog === "create") {
			if (!displayName.trim() || !directoryName.trim()) return;
			actions.createProject(displayName.trim(), directoryName.trim());
		} else {
			if (!selectedFolder) return;
			actions.registerProject([selectedFolder], displayName.trim() || undefined);
		}
		onClose();
	}
	return (
		<Modal
			title={dialog === "create" ? "Create project folder" : "Register existing project"}
			eyebrow="CONTROLLED PROJECT SANDBOX"
			onClose={onClose}
		>
			<form className="modal-form" onSubmit={submit}>
				<p className="modal-form__note">
					This developer-alpha flow is restricted to the server-owned sandbox. Native and WSL paths are typed seams
					only.
				</p>
				<label>
					<span>Project name</span>
					<input
						value={displayName}
						onChange={(event) => setDisplayName(event.target.value)}
						placeholder={dialog === "create" ? "Orbital Solver" : "Optional display name"}
						pattern={NON_BLANK_PATTERN}
						title="Enter at least one non-space character."
						required={dialog === "create"}
					/>
				</label>
				{dialog === "create"
					? (
						<label>
							<span>Folder name</span>
							<input
								value={directoryName}
								onChange={(event) => setDirectoryName(event.target.value)}
								placeholder="orbital-solver"
								pattern={NON_BLANK_PATTERN}
								title="Enter at least one non-space character."
								required
							/>
						</label>
					)
					: (
						<label>
							<span>Available sandbox folder</span>
							<select value={selectedFolder} onChange={(event) => setSelectedFolder(event.target.value)} required>
								{registerableFolders.length === 0 && <option value="">No unregistered folders</option>}
								{registerableFolders.map((folder) => <option value={folder} key={folder}>{folder}</option>)}
							</select>
						</label>
					)}
				<div className="modal__actions">
					<button type="button" className="button button--quiet" onClick={onClose}>Cancel</button>
					<button type="submit" className="button button--primary">
						{dialog === "create" ? "Create project" : "Register project"}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function FileOperationModal({
	dialog,
	workspace,
	selectedNode,
	onClose,
	actions,
}: {
	dialog: Exclude<FileDialog, null>;
	workspace: ProjectWorkspaceState;
	selectedNode: TreeNode | null;
	onClose(): void;
	actions: WorkbenchActions;
}) {
	const [name, setName] = useState(selectedNode?.name ?? "");
	const [destinationParent, setDestinationParent] = useState(parentPath(selectedNode?.path.segments ?? []).join("/"));
	const selectedParent = selectedNode?.kind === "directory"
		? selectedNode.path.segments
		: parentPath(selectedNode?.path.segments ?? []);
	const parentLabel = selectedParent.length ? selectedParent.join("/") : "/";
	function submit(event: FormEvent) {
		event.preventDefault();
		if (dialog === "delete") {
			if (selectedNode) {
				actions.prepareDelete(workspace.project.id, selectedNode.path.segments, selectedNode.nodeVersion);
			}
		} else if (dialog === "move") {
			if (!selectedNode || !name.trim()) return;
			const parent = destinationParent.split("/").filter(Boolean);
			actions.moveNode(
				workspace.project.id,
				selectedNode.path.segments,
				{ parent, name: name.trim() },
				selectedNode.nodeVersion,
			);
		} else {
			if (!name.trim()) return;
			actions.createNode(
				workspace.project.id,
				selectedParent,
				name.trim(),
				dialog === "create-file" ? "file" : "folder",
			);
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
		<Modal title={title} eyebrow={`PROJECT SCOPE · ${workspace.project.displayName.toUpperCase()}`} onClose={onClose}>
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
									onChange={(event) =>
										setName(event.target.value)}
									placeholder={dialog === "create-file" ? "notes.md" : "results"}
									pattern={NON_BLANK_PATTERN}
									title="Enter at least one non-space character."
									required
								/>
							</label>
							<p className="modal-form__note">
								Destination parent:{" "}
								<code>{dialog === "move" ? destinationParent || "/" : parentLabel}</code>. Existing entries are never
								overwritten.
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
						{dialog === "delete" ? "Inspect and prepare" : "Apply in sandbox"}
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
	challenge: DeleteChallenge;
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
				<p>The server bound this challenge to the exact project, path, and inspected node fingerprint.</p>
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

function BottomStatus({ state, workspace, obscured }: {
	state: AppState;
	workspace: ProjectWorkspaceState;
	obscured: boolean;
}) {
	const operationActive = workspace.activeTurnId !== null || workspace.pendingPermission !== null ||
		isEngineOperationActive(workspace.engine.phase);
	const operationLabel = workspace.engine.phase === "cancelling"
		? `cancelling ${ENGINE_NAMES[workspace.engine.kind].toLowerCase()} turn`
		: `${ENGINE_NAMES[workspace.engine.kind].toLowerCase()} turn`;
	const factState = (key: "target" | "authentication" | "context") =>
		workspace.engine.facts.find((fact) => fact.key === key)?.state ?? "unavailable";
	return (
		<footer
			className="status-bar"
			aria-label="Workbench status"
			aria-hidden={obscured ? true : undefined}
			inert={obscured}
		>
			<div>
				<StatusMark tone={state.connection === "connected" ? "success" : "error"} label={state.connection} />
				<span>{state.mode} host · 127.0.0.1 · token bound</span>
			</div>
			<div>
				<span>Target</span>
				<strong>{factState("target")}</strong>
			</div>
			<div>
				<span>Authentication</span>
				<strong>{factState("authentication")}</strong>
			</div>
			<div>
				<span>Context</span>
				<strong>{factState("context")}</strong>
			</div>
			<div className={operationActive ? "status-bar__operation is-active" : "status-bar__operation"}>
				<span>Operation</span>
				<strong>{operationActive ? operationLabel : "idle"}</strong>
			</div>
		</footer>
	);
}

export function WorkbenchView({ state, dispatch, actions }: WorkbenchViewProps) {
	const workspace = selectedWorkspace(state);
	const leftRailIsDrawer = useMediaQuery("(max-width: 790px)");
	const rightRailIsDrawer = useMediaQuery("(max-width: 1050px)");
	const [projectDialog, setProjectDialog] = useState<ProjectDialog>(null);
	const [fileDialog, setFileDialog] = useState<FileDialog>(null);
	const [selectedNodes, setSelectedNodes] = useState<Record<string, TreeNode | null>>({});
	const previousLeftDrawerOpen = useRef(state.leftDrawerOpen);
	const previousRightDrawerOpen = useRef(state.rightDrawerOpen);
	const selectedNode = workspace ? (selectedNodes[workspace.project.id] ?? null) : null;
	const slotActive = Object.values(state.projects).some((project) =>
		project.activeTurnId !== null || project.pendingPermission !== null || isEngineOperationActive(project.engine.phase)
	);
	const modalIsOpen = projectDialog !== null || fileDialog !== null || Boolean(workspace?.deleteChallenge);
	const leftDrawerObscures = leftRailIsDrawer && state.leftDrawerOpen;
	const rightDrawerObscures = rightRailIsDrawer && state.rightDrawerOpen;
	const backgroundObscured = modalIsOpen || leftDrawerObscures || rightDrawerObscures;

	useEffect(() => {
		setFileDialog(null);
	}, [state.selectedProjectId]);

	useEffect(() => {
		if (leftRailIsDrawer && state.leftDrawerOpen) {
			document.querySelector<HTMLButtonElement>(".left-rail__close")?.focus();
		} else if (leftRailIsDrawer && previousLeftDrawerOpen.current) {
			document.querySelector<HTMLButtonElement>(".mobile-controls:first-child button")?.focus();
		}
		previousLeftDrawerOpen.current = state.leftDrawerOpen;
	}, [leftRailIsDrawer, state.leftDrawerOpen]);

	useEffect(() => {
		if (rightRailIsDrawer && state.rightDrawerOpen) {
			document.querySelector<HTMLButtonElement>(".right-rail__close")?.focus();
		} else if (rightRailIsDrawer && previousRightDrawerOpen.current) {
			document.querySelector<HTMLButtonElement>(".mobile-controls:last-child button")?.focus();
		}
		previousRightDrawerOpen.current = state.rightDrawerOpen;
	}, [rightRailIsDrawer, state.rightDrawerOpen]);

	useEffect(() => {
		if (modalIsOpen || (!leftDrawerObscures && !rightDrawerObscures)) return;
		const constrainDrawerFocus = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				dispatch({ type: "drawer.left", open: false });
				dispatch({ type: "drawer.right", open: false });
				return;
			}
			const activeDrawer = document.querySelector<HTMLElement>(
				leftDrawerObscures ? "#project-rail" : "#activity-rail",
			);
			if (activeDrawer) containTabKey(event, activeDrawer);
		};
		document.addEventListener("keydown", constrainDrawerFocus);
		return () => document.removeEventListener("keydown", constrainDrawerFocus);
	}, [dispatch, leftDrawerObscures, modalIsOpen, rightDrawerObscures]);

	if (state.boot === "loading") return <LoadingScreen />;
	if (state.boot === "failed" || !workspace) {
		return <FailureScreen message={state.bootError ?? "No selected project was returned."} />;
	}

	return (
		<div className="workbench-shell">
			<div className="ambient-grid" aria-hidden="true" />
			<div className="sr-only" aria-live="assertive" aria-atomic="true">{state.announcement}</div>
			<div
				className={`drawer-scrim${leftDrawerObscures || rightDrawerObscures ? " is-visible" : ""}`}
				onClick={() => {
					dispatch({ type: "drawer.left", open: false });
					dispatch({ type: "drawer.right", open: false });
				}}
				aria-hidden="true"
			/>
			<ProjectRail
				state={state}
				workspace={workspace}
				dispatch={dispatch}
				onProjectDialog={setProjectDialog}
				onSelectProject={actions.selectProject}
				selectedNode={selectedNode}
				onSelectNode={(node) => setSelectedNodes((current) => ({ ...current, [workspace.project.id]: node }))}
				onFileDialog={setFileDialog}
				onRefresh={() => actions.refreshTree(workspace.project.id)}
				slotActive={slotActive}
				isDrawer={leftRailIsDrawer}
				obscured={modalIsOpen || rightDrawerObscures}
			/>
			<ConversationCanvas
				workspace={workspace}
				state={state}
				dispatch={dispatch}
				actions={actions}
				engineLocked={slotActive}
				obscured={backgroundObscured}
			/>
			<RightRail
				state={state}
				workspace={workspace}
				dispatch={dispatch}
				isDrawer={rightRailIsDrawer}
				obscured={modalIsOpen || leftDrawerObscures}
			/>
			<BottomStatus state={state} workspace={workspace} obscured={backgroundObscured} />
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

			{projectDialog && (
				<ProjectOperationModal
					dialog={projectDialog}
					registerableFolders={state.registerableSandboxFolders}
					onClose={() => setProjectDialog(null)}
					actions={actions}
				/>
			)}
			{fileDialog && (
				<FileOperationModal
					dialog={fileDialog}
					workspace={workspace}
					selectedNode={selectedNode}
					onClose={() => setFileDialog(null)}
					actions={actions}
				/>
			)}
			{workspace.deleteChallenge && (
				<DeleteConfirmationModal
					challenge={workspace.deleteChallenge}
					projectId={workspace.project.id}
					onClose={() => actions.refreshTree(workspace.project.id)}
					actions={actions}
				/>
			)}
		</div>
	);
}

export default WorkbenchView;
