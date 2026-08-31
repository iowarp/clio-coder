import {
	forwardRef,
	memo,
	useCallback,
	useDeferredValue,
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Dispatch, FormEvent, KeyboardEvent, ReactNode } from "react";
import { AUTONOMY_LEVELS, PRODUCT_NAME, THINKING_LEVELS } from "./protocol.ts";
import type {
	WireAutonomyLevel,
	WireCatalogAgent,
	WireCatalogExtension,
	WireCatalogInspection,
	WireCatalogLibraryEntry,
	WireCatalogSkill,
	WireClioPhase,
	WireConfigInspection,
	WireConfigSettingSource,
	WireCustomizationCategory,
	WireCustomizationEntry,
	WireCustomizationReloadClass,
	WireDeleteChallenge,
	WireDispatchInspection,
	WireEventSource,
	WireFleetInspection,
	WireFleetInspectionRun,
	WireFleetInspectionStep,
	WirePendingPermission,
	WireProjectSummary,
	WireRecoveryCheckLevel,
	WireRecoveryInspection,
	WireRecoverySectionId,
	WireRoutingInspection,
	WireRoutingModel,
	WireSessionSummary,
	WireSettingsPatch,
	WireTarget,
	WireTimelineItem,
	WireToolchainInspection,
	WireToolchainItem,
	WireTreeNode,
	WireUsage,
	WireUsageInspection,
} from "./protocol.ts";
import { groupTurns, SOURCE_LABELS } from "./chat.ts";
import { ChatTranscript, FleetStrip, JumpToLatest, type ScrollPosition, useFollowLatest } from "./Chat.tsx";
import { formatDuration, formatTimestamp } from "./format.ts";
import { type AppAction, type AppState, formatProjectPath, isPromptBlocked, type OpenWorkspaceState } from "./state.ts";

export { formatDuration, formatTimestamp } from "./format.ts";

export interface WorkbenchActions {
	browseProjects(path?: string): void;
	openProject(path: string): void;
	selectProject(projectId: string): void;
	forgetProject(projectId: string): void;
	refreshTree(projectId: string, directory?: readonly string[]): void;
	createNode(
		projectId: string,
		parent: readonly string[],
		name: string,
		kind: "file" | "folder",
	): void;
	moveNode(
		projectId: string,
		source: readonly string[],
		destination: { parent: readonly string[]; name: string },
		expectedNodeVersion?: string,
	): void;
	prepareDelete(
		projectId: string,
		target: readonly string[],
		expectedNodeVersion?: string,
	): void;
	confirmDelete(projectId: string, confirmationId: string): void;
	newSession(projectId: string): void;
	loadSession(projectId: string, sessionId: string): void;
	closeSession(projectId: string): void;
	listSessions(projectId: string): void;
	labelSession(projectId: string, sessionId: string, label: string): void;
	deleteSession(projectId: string, sessionId: string): void;
	startTurn(projectId: string, prompt: string): void;
	cancelTurn(projectId: string, turnId: string): void;
	resolvePermission(
		projectId: string,
		turnId: string,
		permissionId: string,
		decision: "allow-once" | "reject",
	): void;
	getSettings(projectId: string): void;
	patchSettings(projectId: string, patch: WireSettingsPatch): void;
	inspectConfig(projectId: string): void;
	inspectCatalog(projectId: string): void;
	inspectUsage(projectId: string): void;
	inspectRouting(projectId: string): void;
	inspectDispatch(): void;
	inspectFleet(): void;
	inspectToolchain(): void;
	inspectRecovery(): void;
	listTargets(projectId: string): void;
	probeTarget(projectId: string, targetId: string): void;
	setAutonomy(projectId: string, level: WireAutonomyLevel): void;
}

interface WorkbenchViewProps {
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
	/** The view shown before the operator switches; tests use it to render the Session Timeline directly. */
	initialView?: WorkspaceView;
}

type FileDialog = "create-file" | "create-folder" | "move" | "delete" | null;
type WorkspaceView =
	| "conversation"
	| "timeline"
	| "effective-clio-coder"
	| "catalog"
	| "usage"
	| "dispatch"
	| "fleet-runs";

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const NON_BLANK_PATTERN = String.raw`.*\S.*`;

function focusableWithin(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
		.filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function containTabKey(
	event: globalThis.KeyboardEvent,
	container: HTMLElement,
): void {
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
	if (
		event.shiftKey &&
		(document.activeElement === first ||
			!container.contains(document.activeElement))
	) {
		event.preventDefault();
		last.focus();
	} else if (
		!event.shiftKey &&
		(document.activeElement === last ||
			!container.contains(document.activeElement))
	) {
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

const PHASE_PRESENTATION: Record<
	WireClioPhase,
	{ label: string; tone: string }
> = {
	starting: { label: "Starting Clio Coder", tone: "info" },
	unbound: { label: "No session", tone: "info" },
	idle: { label: "Idle", tone: "success" },
	running: { label: "Running", tone: "action" },
	"awaiting-approval": { label: "Awaiting approval", tone: "warning" },
	cancelling: { label: "Stopping", tone: "warning" },
	failed: { label: "Failed", tone: "error" },
	closed: { label: "Closed", tone: "info" },
};

const SOURCE_GUIDANCE: Record<
	WireEventSource,
	{ label: string; description: string }
> = {
	"reported-by-clio": {
		label: "Clio Coder reported",
		description: "Clio Coder supplied this fact; the desktop app did not measure it independently.",
	},
	"observed-on-acp": {
		label: "Observed live",
		description: "The desktop app received this event on Clio Coder's live control channel.",
	},
	"observed-by-workbench": {
		label: "Observed locally",
		description: "The desktop app observed this fact in its own project or process boundary.",
	},
	"replayed-from-clio": {
		label: "Earlier record",
		description: "Clio Coder replayed this from an earlier turn in the same session.",
	},
};

const SETTING_GUIDANCE: Record<
	string,
	{ label: string; description: string; scope: string | null }
> = {
	"orchestrator.target": {
		label: "Clio Coder target",
		description: "The configured service or runtime Clio Coder will route the next turn through.",
		scope: "NEXT TURN",
	},
	"orchestrator.model": {
		label: "Model",
		description: "The model Clio Coder will ask to work on the next turn.",
		scope: "NEXT TURN",
	},
	"orchestrator.thinkingLevel": {
		label: "Reasoning effort",
		description: "Clio Coder's configured reasoning depth. The GUI does not infer what the bound session already uses.",
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
	if (
		key === "orchestrator.thinkingLevel" &&
		(THINKING_LEVELS as readonly string[]).includes(value)
	) {
		return {
			"orchestrator.thinkingLevel": value as (typeof THINKING_LEVELS)[number],
		};
	}
	if (key === "autonomy" && isAutonomyLevel(value)) return { autonomy: value };
	return null;
}

const SESSION_STATE_LABELS: Record<WireSessionSummary["state"], string> = {
	open: "open",
	closed: "closed",
	unknown: "unknown",
};

const UNKNOWN_SESSION_NOTE = "Clio Coder cannot tell whether another process still holds this session.";

const CUSTOMIZATION_CATEGORY_PRESENTATION: Record<
	WireCustomizationCategory,
	{
		readonly label: string;
		readonly short: string;
		readonly description: string;
	}
> = {
	settings: {
		label: "Settings",
		short: "SET",
		description: "Layered values that shape Clio Coder's behavior.",
	},
	"clio-md": {
		label: "Project context",
		short: "CTX",
		description: "CLIO-CODER.md context Clio Coder can add to the next turn.",
	},
	rule: {
		label: "Rules",
		short: "RUL",
		description: "Project rules and conditional context boundaries.",
	},
	"operator-profile": {
		label: "Operator profile",
		short: "OPR",
		description: "Declared operator preferences added to context.",
	},
	hook: {
		label: "Hooks",
		short: "HOK",
		description: "Middleware reactions loaded by Clio Coder.",
	},
	extension: {
		label: "Extensions",
		short: "EXT",
		description: "Installed packages and their effective precedence.",
	},
	"skill-root": {
		label: "Skill roots",
		short: "SKL",
		description: "Locations Clio Coder searches for skills.",
	},
	"prompt-root": {
		label: "Prompt roots",
		short: "PMT",
		description: "Locations Clio Coder searches for saved prompts.",
	},
	agents: {
		label: "Agents",
		short: "AGT",
		description: "Agent recipe sources visible to this project.",
	},
	safety: {
		label: "Safety",
		short: "SAFE",
		description: "Effective working-freedom and safety facts.",
	},
	memory: {
		label: "Memory",
		short: "MEM",
		description: "The durable memory surface Clio Coder can consult.",
	},
};

const CUSTOMIZATION_CATEGORY_ORDER = Object.keys(
	CUSTOMIZATION_CATEGORY_PRESENTATION,
) as WireCustomizationCategory[];

const RELOAD_PRESENTATION: Record<
	WireCustomizationReloadClass,
	{ readonly label: string; readonly description: string }
> = {
	hot: {
		label: "Now",
		description: "Clio Coder reports this surface as hot-reloadable.",
	},
	"next-turn": {
		label: "Next turn",
		description: "Clio Coder reads this surface when the next turn begins.",
	},
	restart: {
		label: "Restart",
		description: "A new Clio Coder process is required before this changes.",
	},
	"n/a": {
		label: "Informational",
		description: "No apply timing is attached to this entry.",
	},
};

const SETTING_SOURCE_LABELS: Record<WireConfigSettingSource, string> = {
	"built-in": "Built in",
	user: "User",
	project: "Project",
	"project.local": "Project local",
	cli: "Command line",
};

const USAGE_FIELDS = [
	{
		key: "input",
		label: "Prompt + context",
		shortLabel: "Input",
		description: "Text and context supplied to the model for the turn.",
	},
	{
		key: "output",
		label: "Answer produced",
		shortLabel: "Output",
		description: "Text produced by the model for the turn.",
	},
	{
		key: "cacheRead",
		label: "Context reused",
		shortLabel: "Cache read",
		description: "Previously cached context the provider says it reused.",
	},
	{
		key: "cacheWrite",
		label: "Context cached",
		shortLabel: "Cache write",
		description: "Context the provider says it added to a cache.",
	},
	{
		key: "reasoning",
		label: "Model reasoning",
		shortLabel: "Reasoning",
		description: "Reasoning tokens reported separately by the provider.",
	},
] as const satisfies ReadonlyArray<{
	key: keyof WireUsage;
	label: string;
	shortLabel: string;
	description: string;
}>;

function formatTokenCount(value: number | bigint): string {
	return value.toLocaleString();
}

function aggregateVisibleUsage(timeline: readonly WireTimelineItem[]) {
	const totals: Record<keyof WireUsage, bigint> = {
		input: 0n,
		output: 0n,
		cacheRead: 0n,
		cacheWrite: 0n,
		reasoning: 0n,
	};
	let reports = 0;
	for (const item of timeline) {
		if (item.usage === undefined) continue;
		reports += 1;
		for (const field of USAGE_FIELDS) {
			totals[field.key] += BigInt(item.usage[field.key]);
		}
	}
	return { reports, totals } as const;
}

function usageBarWidth(value: bigint, maximum: bigint): string {
	if (value === 0n || maximum === 0n) return "0%";
	const tenthsOfPercent = (value * 1_000n) / maximum;
	return `${Number(tenthsOfPercent) / 10}%`;
}

function TurnUsageRecord({ usage }: { usage: WireUsage }) {
	return (
		<dl
			className="turn-usage"
			aria-label="Token fields reported by Clio Coder for this turn"
		>
			{USAGE_FIELDS.map((field) => (
				<div key={field.key} title={field.description}>
					<dt>{field.shortLabel}</dt>
					<dd>{formatTokenCount(usage[field.key])}</dd>
				</div>
			))}
		</dl>
	);
}

function Glyph({ children }: { children: ReactNode }) {
	return <span aria-hidden="true">{children}</span>;
}

function StatusMark(
	{ tone = "neutral", label }: { tone?: string; label: string },
) {
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
				<img
					src="/assets/clio-coder-logo-128.webp"
					width="40"
					height="40"
					alt=""
				/>
			</div>
			<div>
				<div className="brand-lockup__eyebrow">IOWARP · CLIO CODER</div>
				<div className="brand-lockup__name">{PRODUCT_NAME}</div>
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
			<small>
				The Clio Coder desktop app talks to one Clio Coder process and never edits Clio Coder configuration behind your
				back.
			</small>
		</main>
	);
}

function FailureScreen({ message }: { message: string }) {
	return (
		<main className="boot-screen boot-screen--failed" id="conversation">
			<BrandLockup />
			<div role="alert">
				<p className="kicker">LOCALHOST STARTUP FAILED</p>
				<h1>{PRODUCT_NAME} could not establish its local control channel.</h1>
				<pre>{message}</pre>
			</div>
			<button
				type="button"
				className="button button--primary"
				onClick={() => location.reload()}
			>
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

function pathKey(
	path: Readonly<{ segments: readonly string[] }> | readonly string[],
): string {
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
							<Glyph>
								{isDirectory ? "▾" : node.kind === "symlink" ? "⊘" : "·"}
							</Glyph>
							<span className="file-node__kind" aria-hidden="true">
								{isDirectory ? "▱" : node.kind === "symlink" ? "↗" : "≡"}
							</span>
							<span className="file-node__name">{node.name}</span>
							{isBlocked && <span className="file-node__blocked">blocked</span>}
						</button>
						{node.children && node.children.length > 0 && (
							<TreeBranch
								nodes={node.children}
								selected={selected}
								onSelect={onSelect}
								level={level + 1}
							/>
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
				<button
					type="submit"
					className="button button--primary"
					disabled={busy || path.trim().length === 0}
				>
					Open
				</button>
			</div>
			<button
				type="button"
				className="button button--quiet open-project__browse"
				onClick={onBrowse}
			>
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
	const title = session.label ??
		(session.preview.length > 0 ? session.preview : "Untitled session");

	function commitLabel(event: FormEvent) {
		event.preventDefault();
		actions.labelSession(open.project.id, session.id, draft.trim());
		setEditing(false);
	}

	return (
		<article className={`session-row${bound ? " is-bound" : ""}`}>
			<span
				className={`session-row__mark session-row__mark--${session.state}`}
				aria-hidden="true"
			/>
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
							<button type="submit" className="button button--quiet">
								Save
							</button>
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
	const title = session.label ??
		(session.preview.length > 0 ? session.preview : "Untitled session");
	return (
		<Modal
			title="Delete this session"
			eyebrow="PERMANENT · NOT RECOVERABLE"
			onClose={onClose}
		>
			<div className="delete-confirmation">
				<div className="delete-confirmation__target">
					<span>SESSION</span>
					<code>{title}</code>
				</div>
				<p>
					Clio Coder deletes this session and its {session.turns}{" "}
					recorded turns. Neither the desktop app nor Clio Coder can bring them back.
				</p>
				<div className="modal__actions">
					<button
						type="button"
						className="button button--quiet"
						onClick={onClose}
					>
						Keep session
					</button>
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

interface ProjectRailProps {
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
	selectedNode: WireTreeNode | null;
	onSelectNode(node: WireTreeNode): void;
	onFileDialog(dialog: FileDialog): void;
	onDeleteSession(session: WireSessionSummary): void;
	isDrawer: boolean;
	desktopCollapsed: boolean;
	onDesktopCollapse(): void;
	obscured: boolean;
}

const ProjectRail = memo(function ProjectRail({
	state,
	dispatch,
	actions,
	selectedNode,
	onSelectNode,
	onFileDialog,
	onDeleteSession,
	isDrawer,
	desktopCollapsed,
	onDesktopCollapse,
	obscured,
}: ProjectRailProps) {
	const open = state.open;
	// Only a live turn locks project switching; having no project open must never
	// disable the control that opens one.
	const busy = open !== null && isPromptBlocked(open);
	const unavailable = obscured || (isDrawer && !state.leftDrawerOpen) ||
		(!isDrawer && desktopCollapsed);
	return (
		<aside
			id="project-rail"
			className={`left-rail${isDrawer && state.leftDrawerOpen ? " is-open" : ""}`}
			aria-label="Projects, files, and sessions"
			aria-hidden={unavailable ? true : undefined}
			inert={unavailable}
			hidden={!isDrawer && desktopCollapsed}
		>
			<div className="left-rail__brand">
				<BrandLockup compact />
				<button
					type="button"
					className="icon-button left-rail__close"
					onClick={() => isDrawer ? dispatch({ type: "drawer.left", open: false }) : onDesktopCollapse()}
				>
					<Glyph>{isDrawer ? "×" : "‹"}</Glyph>
					<span className="sr-only">
						{isDrawer ? "Close projects and files" : "Collapse projects, files, and sessions"}
					</span>
				</button>
			</div>

			<section
				className="rail-section rail-section--projects"
				aria-labelledby="project-library-title"
			>
				<PanelHeading
					eyebrow="PROJECT"
					title="Open a folder"
					headingId="project-library-title"
				/>
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
								<div
									className={`project-card-row${missing ? " is-missing" : ""}`}
									key={project.id}
								>
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
											{missing && (
												<small className="project-card__missing">
													cannot be opened
												</small>
											)}
										</span>
									</button>
									{missing
										? (
											<div className="project-recovery">
												<p className="project-recovery__reason">
													The GUI can no longer open this folder. It may have been moved, renamed, or deleted, or it may
													now be a location the GUI refuses to open. Removing it from this list changes nothing on disk.
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
												<span className="sr-only">
													Forget {project.displayName}
												</span>
											</button>
										)}
								</div>
							);
						})}
				</div>
				{busy && (
					<p className="project-lock-note">
						Clio Coder is working. Projects can be switched between turns.
					</p>
				)}
			</section>

			{open && (
				<>
					<section
						className="rail-section rail-section--files"
						aria-labelledby="files-title"
					>
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
							<button
								type="button"
								className="button button--quiet"
								onClick={() => onFileDialog("create-file")}
							>
								New file
							</button>
							<button
								type="button"
								className="button button--quiet"
								onClick={() => onFileDialog("create-folder")}
							>
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
								? (
									<div className="compact-empty">
										This project has no files yet.
									</div>
								)
								: (
									<TreeBranch
										nodes={open.tree}
										selected={selectedNode ? pathKey(selectedNode.path) : null}
										onSelect={onSelectNode}
									/>
								)}
							{open.treeTruncated && (
								<p className="tree-note">
									Tree capped at the project safety limit.
								</p>
							)}
						</div>
					</section>

					<section
						className="rail-section rail-section--sessions"
						aria-labelledby="sessions-title"
					>
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
								? (
									<p className="rail-empty">
										Clio Coder has no session for this project yet.
									</p>
								)
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
							<p className="tree-note">
								This list is shortened; Clio Coder has more sessions than are shown.
							</p>
						)}
						{open.clio.capabilities?.list === false && (
							<p className="tree-note">
								This Clio Coder cannot list its earlier sessions over ACP.
							</p>
						)}
					</section>
				</>
			)}
		</aside>
	);
}, sameProjectRailProps);

function sameProjectRailProps(
	previous: ProjectRailProps,
	next: ProjectRailProps,
): boolean {
	const previousOpen = previous.state.open;
	const nextOpen = next.state.open;
	const sameOpen = previousOpen === nextOpen || (
		previousOpen !== null && nextOpen !== null &&
		previousOpen.project === nextOpen.project &&
		previousOpen.tree === nextOpen.tree &&
		previousOpen.treeTruncated === nextOpen.treeTruncated &&
		previousOpen.sessions === nextOpen.sessions &&
		previousOpen.sessionsTruncated === nextOpen.sessionsTruncated &&
		previousOpen.clio === nextOpen.clio
	);
	return sameOpen &&
		previous.state.recent === next.state.recent &&
		previous.state.leftDrawerOpen === next.state.leftDrawerOpen &&
		previous.dispatch === next.dispatch &&
		previous.actions === next.actions &&
		previous.selectedNode === next.selectedNode &&
		previous.onSelectNode === next.onSelectNode &&
		previous.onFileDialog === next.onFileDialog &&
		previous.onDeleteSession === next.onDeleteSession &&
		previous.isDrawer === next.isDrawer &&
		previous.desktopCollapsed === next.desktopCollapsed &&
		previous.onDesktopCollapse === next.onDesktopCollapse &&
		previous.obscured === next.obscured;
}

/** A tool that has been open this long is worth saying so about, in seconds. */
const LONG_RUNNING_TOOL_SECONDS = 30;

const TimelineCard = memo(
	function TimelineCard(
		{ item, nowMs }: { item: WireTimelineItem; nowMs: number },
	) {
		const startedMs = item.startedAt === null ? Number.NaN : Date.parse(item.startedAt);
		const activeSeconds = item.status === "active" && Number.isFinite(startedMs)
			? Math.max(0, Math.floor((nowMs - startedMs) / 1_000))
			: 0;
		const longRunning = item.kind === "tool" &&
			activeSeconds >= LONG_RUNNING_TOOL_SECONDS;
		return (
			<article
				className={`timeline-card timeline-card--${item.kind} is-${item.status}${
					item.origin === "replay" ? " timeline-card--replay" : ""
				}${longRunning ? " timeline-card--long" : ""}`}
			>
				<div className="timeline-card__meta">
					<span className="timeline-card__kind">{item.kind}</span>
					<span className="timeline-card__source">
						{SOURCE_LABELS[item.source]}
					</span>
					{item.origin === "replay" && <span className="timeline-card__replay">earlier</span>}
					{longRunning && (
						<span className="timeline-card__long">
							still running · {formatDuration(activeSeconds)}
						</span>
					)}
				</div>
				<h3>{item.title}</h3>
				<p className="timeline-card__summary">{item.summary}</p>
				{item.detail && <pre className="timeline-card__detail">{item.detail}</pre>}
				{item.usage !== undefined && <TurnUsageRecord usage={item.usage} />}
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
					{item.startedAt !== null && (
						<time dateTime={item.startedAt}>
							{formatTimestamp(item.startedAt)}
						</time>
					)}
				</div>
			</article>
		);
	},
);

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
					Nothing runs until you answer. The GUI never answers for you.
				</p>
				<div className="approval-card__actions">
					<button
						type="button"
						className="button button--quiet"
						onClick={() => onResolve("reject")}
					>
						Reject
					</button>
					<button
						type="button"
						className="button button--action"
						onClick={() => onResolve("allow-once")}
					>
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
				<div className="eyebrow">
					{escalated ? "APPROVAL WAITING · ESCALATED" : "APPROVAL NEEDED"}
				</div>
				<strong id="approval-banner-title">{permission.title}</strong>
				<span className="approval-banner__facts">
					{permission.kind} · waiting {formatDuration(elapsed)}
				</span>
			</div>
			<div className="approval-banner__actions">
				<button
					type="button"
					className="button button--quiet"
					onClick={() => onResolve("reject")}
				>
					Reject
				</button>
				<button
					type="button"
					className="button button--action"
					onClick={() => onResolve("allow-once")}
				>
					Allow once
				</button>
				<span className="approval-banner__keys">
					Alt+A allows once · Alt+R rejects
				</span>
			</div>
		</section>
	);
}

function FirstRunGuide(
	{ state, onBrowse }: { state: AppState; onBrowse(): void },
) {
	return (
		<section className="first-run" aria-labelledby="first-run-title">
			<div className="first-run__intro">
				<div className="eyebrow">A FIELD OBSERVATORY FOR CODE</div>
				<h2 id="first-run-title">
					Bring a research folder. Keep every decision visible.
				</h2>
				<p>
					The Clio Coder desktop app gives one real Clio Coder process a bounded place to work, then turns its requests,
					actions, and outcomes into a record you can inspect. You can start with a question; you do not need to start
					with a command.
				</p>
				<div className="first-run__actions">
					<button
						type="button"
						className="button button--primary"
						onClick={onBrowse}
					>
						Choose a project folder
					</button>
					<span>or enter a path in the Project panel</span>
				</div>
			</div>

			<ol className="first-run__steps" aria-label={`How ${PRODUCT_NAME} works`}>
				<li>
					<span aria-hidden="true">01</span>
					<div>
						<strong>Open one project</strong>
						<p>
							Choose the folder that contains your notes, data, scripts, or application.
						</p>
					</div>
				</li>
				<li>
					<span aria-hidden="true">02</span>
					<div>
						<strong>Describe the outcome</strong>
						<p>
							Ask in your own words. Clio Coder plans and uses the tools its configuration permits.
						</p>
					</div>
				</li>
				<li>
					<span aria-hidden="true">03</span>
					<div>
						<strong>Inspect the evidence</strong>
						<p>
							See what was observed, what Clio Coder reported, and where your approval was required.
						</p>
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
						The Clio Coder desktop app control channel stays on this machine. Prompts go only to the Clio Coder target
						you configure.
					</p>
				</article>
				<article>
					<div className="eyebrow">DESKTOP STATE</div>
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

interface EvidenceRailProps {
	state: AppState;
	nowMs: number;
	isDrawer: boolean;
	drawerOpen: boolean;
	onClose(): void;
	desktopCollapsed: boolean;
	onDesktopCollapse(): void;
	workspaceView: WorkspaceView;
	onOpenConfigMap(): void;
	onOpenCatalog(): void;
	onOpenUsage(): void;
	onOpenDispatch(): void;
	onOpenTimeline(): void;
	obscured: boolean;
}

const EvidenceRail = memo(function EvidenceRail({
	state,
	nowMs,
	isDrawer,
	drawerOpen,
	onClose,
	desktopCollapsed,
	onDesktopCollapse,
	workspaceView,
	onOpenConfigMap,
	onOpenCatalog,
	onOpenUsage,
	onOpenDispatch,
	onOpenTimeline,
	obscured,
}: EvidenceRailProps) {
	const open = state.open;
	const timeline = open?.projection.timeline ?? [];
	const activeTurn = open?.projection.activeTurn ?? null;
	const trace = timeline.slice(-TRACE_LIMIT);
	const sourceCounts = (Object.keys(SOURCE_GUIDANCE) as WireEventSource[]).map((
		source,
	) => ({
		source,
		count: timeline.filter((item) => item.source === source).length,
	})).filter(({ count }) => count > 0);
	const toolCount = timeline.filter((item) => item.kind === "tool").length;
	const outcomeCount = timeline.filter((item) => item.kind === "outcome").length;
	const attentionCount = timeline.filter((item) => item.status === "failed" || item.status === "canceled").length;
	const visibleUsage = aggregateVisibleUsage(timeline);
	const hasTerminalRecord = timeline.some((item) => item.kind === "outcome" || item.kind === "failure");
	const maximumUsageField = USAGE_FIELDS.reduce(
		(maximum, field) => visibleUsage.totals[field.key] > maximum ? visibleUsage.totals[field.key] : maximum,
		0n,
	);
	const configInspection = open?.configInspection ?? null;
	const catalogInspection = open?.catalogInspection ?? null;
	const usageInspection = open?.usageInspection ?? null;
	const dispatchInspection = state.dispatchInspection;
	const configContextTokens = configInspection?.entries.reduce(
		(total, entry) => total + (entry.contextCostTokens ?? 0),
		0,
	) ?? 0;
	const configIssues = configInspection?.issueCounts.reduce((total, issue) => total + issue.count, 0) ?? 0;
	const startedMs = activeTurn === null ? Number.NaN : Date.parse(activeTurn.startedAt);
	const activeSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs - startedMs) / 1_000)) : 0;
	const unavailable = obscured || (isDrawer && !drawerOpen) ||
		(!isDrawer && desktopCollapsed);

	return (
		<aside
			id="evidence-rail"
			className={`evidence-rail instrument-panel${isDrawer && drawerOpen ? " is-open" : ""}`}
			aria-label="Run and evidence overview"
			aria-hidden={unavailable ? true : undefined}
			inert={unavailable}
			hidden={!isDrawer && desktopCollapsed}
		>
			<header className="evidence-rail__header">
				<div>
					<div className="eyebrow">OBSERVATORY</div>
					<h2>Run record</h2>
				</div>
				<button
					type="button"
					className="icon-button evidence-rail__close"
					onClick={isDrawer ? onClose : onDesktopCollapse}
				>
					<Glyph>{isDrawer ? "×" : "›"}</Glyph>
					<span className="sr-only">
						{isDrawer ? "Close run and evidence overview" : "Collapse run and evidence overview"}
					</span>
				</button>
			</header>

			<div
				className="evidence-rail__scroll"
				tabIndex={0}
				role="region"
				aria-label="Run and evidence details"
			>
				<section
					className="observer-section"
					aria-labelledby="observer-now-title"
				>
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
								<p>
									No run facts exist yet, so this panel intentionally has no telemetry to show.
								</p>
							</div>
						)
						: (
							<>
								<p className="observer-lede">
									{activeTurn === null
										? "Clio Coder is ready for the next research question."
										: `Clio Coder has been working for ${formatDuration(activeSeconds)}.`}
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
												<span>CLIO CODER'S LATEST TOOL</span>
												<strong>{activeTurn.lastToolTitle}</strong>
											</p>
										)}
									</div>
								)}
							</>
						)}
				</section>

				{open !== null && (
					<section
						className="observer-section"
						aria-labelledby="observer-session-title"
					>
						<div className="eyebrow">SESSION ROUTING</div>
						<h3 id="observer-session-title">Bound by Clio Coder</h3>
						{open.clio.session === null
							? (
								<p className="observer-note">
									No session is bound to this project.
								</p>
							)
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

				{open !== null && (
					<section
						className="observer-section observer-section--effective"
						aria-labelledby="observer-effective-title"
					>
						<div className="eyebrow">CONFIGURATION PROVENANCE</div>
						<h3 id="observer-effective-title">
							Why Clio Coder behaves this way
						</h3>
						{configInspection === null
							? (
								<p className="observer-note">
									{state.pendingConfigInspect === null
										? "The read-only Effective Clio Coder inspection has not produced a map yet."
										: "Clio Coder is inspecting settings, context, rules, resources, and apply timing."}
								</p>
							)
							: (
								<dl className="effective-summary">
									<div>
										<dt>Setting facts</dt>
										<dd>{configInspection.settings.length}</dd>
									</div>
									<div>
										<dt>Surfaces</dt>
										<dd>{configInspection.entries.length}</dd>
									</div>
									<div>
										<dt>Context estimate</dt>
										<dd>
											{configContextTokens > 0 ? `~${configContextTokens}` : "—"}
										</dd>
									</div>
									<div>
										<dt>Issues</dt>
										<dd>{configIssues}</dd>
									</div>
								</dl>
							)}
						<button
							type="button"
							className="button button--quiet observer-map-button"
							aria-pressed={workspaceView === "effective-clio-coder"}
							onClick={onOpenConfigMap}
						>
							<span aria-hidden="true">⌘</span>
							{workspaceView === "effective-clio-coder" ? "Effective map open" : "Open Effective Clio Coder map"}
						</button>
					</section>
				)}

				{open !== null && (
					<section
						className="observer-section observer-section--catalog"
						aria-labelledby="observer-catalog-title"
					>
						<div className="eyebrow">DISCOVERED CAPABILITY</div>
						<h3 id="observer-catalog-title">
							What Clio Coder can bring to the work
						</h3>
						{catalogInspection === null
							? (
								<p className="observer-note">
									{state.pendingCatalogInspect === null
										? "Open the read-only atlas to inspect agents, skills, extensions, and library resources."
										: "Clio Coder is reading its typed resource catalogs."}
								</p>
							)
							: (
								<dl className="effective-summary">
									<div>
										<dt>Agents</dt>
										<dd>{catalogInspection.agents.items.length}</dd>
									</div>
									<div>
										<dt>Skills</dt>
										<dd>{catalogInspection.skills.items.length}</dd>
									</div>
									<div>
										<dt>Library</dt>
										<dd>{catalogInspection.library.items.length}</dd>
									</div>
									<div>
										<dt>Extensions</dt>
										<dd>{catalogInspection.extensions.items.length}</dd>
									</div>
								</dl>
							)}
						<button
							type="button"
							className="button button--quiet observer-map-button"
							aria-pressed={workspaceView === "catalog"}
							onClick={onOpenCatalog}
						>
							<span aria-hidden="true">⌗</span>
							{workspaceView === "catalog" ? "Capability atlas open" : "Open capability atlas"}
						</button>
					</section>
				)}

				{open !== null && (
					<section
						className="observer-section observer-section--history"
						aria-labelledby="observer-history-title"
					>
						<div className="eyebrow">PROJECT HISTORY</div>
						<h3 id="observer-history-title">
							What Clio Coder recorded across sessions
						</h3>
						{usageInspection === null
							? (
								<p className="observer-note">
									{state.pendingUsageInspect === null
										? "Open the read-only Usage record for a project-filtered 30-day view."
										: "Clio Coder is reading the bounded project usage record."}
								</p>
							)
							: (
								<dl className="effective-summary">
									<div>
										<dt>Tokens</dt>
										<dd>
											{usageInspection.totals === null ? "—" : formatTokenCount(usageInspection.totals.totalTokens)}
										</dd>
									</div>
									<div>
										<dt>Sessions</dt>
										<dd>{usageInspection.sessionCount ?? "—"}</dd>
									</div>
									<div>
										<dt>Models</dt>
										<dd>{usageInspection.models.length}</dd>
									</div>
									<div>
										<dt>Recipes</dt>
										<dd>{usageInspection.recipes.length}</dd>
									</div>
								</dl>
							)}
						<button
							type="button"
							className="button button--quiet observer-map-button"
							aria-pressed={workspaceView === "usage"}
							onClick={onOpenUsage}
						>
							<span aria-hidden="true">◷</span>
							{workspaceView === "usage" ? "Usage record open" : "Open 30-day Usage record"}
						</button>
					</section>
				)}

				<section
					className="observer-section observer-section--dispatch"
					aria-labelledby="observer-dispatch-title"
				>
					<div className="eyebrow">INSTALLATION DISPATCH</div>
					<h3 id="observer-dispatch-title">
						What Clio Coder's durable fleet ledger reports
					</h3>
					{dispatchInspection === null
						? (
							<p className="observer-note">
								{state.pendingDispatchInspect === null
									? "Open the read-only snapshot for global admission, running-work counts, and durable totals."
									: "Clio Coder is reading its installation-wide dispatch ledger."}
							</p>
						)
						: (
							<dl className="effective-summary">
								<div>
									<dt>Admission</dt>
									<dd>{dispatchInspection.admission.state}</dd>
								</div>
								<div>
									<dt>Running</dt>
									<dd>{dispatchInspection.running.total}</dd>
								</div>
								<div>
									<dt>Tokens</dt>
									<dd>
										{formatTokenCount(dispatchInspection.totals.totalTokens)}
									</dd>
								</div>
								<div>
									<dt>Cost</dt>
									<dd>{formatUsageCost(dispatchInspection.totals.costUsd)}</dd>
								</div>
							</dl>
						)}
					<button
						type="button"
						className="button button--quiet observer-map-button"
						aria-pressed={workspaceView === "dispatch"}
						onClick={onOpenDispatch}
					>
						<span aria-hidden="true">Σ</span>
						{workspaceView === "dispatch" ? "Dispatch snapshot open" : "Open dispatch snapshot"}
					</button>
				</section>

				{open !== null && (
					<section
						className="observer-section"
						aria-labelledby="observer-usage-title"
					>
						<div className="observer-section__heading">
							<div>
								<div className="eyebrow">MODEL WORK</div>
								<h3 id="observer-usage-title">Reported token record</h3>
							</div>
							{visibleUsage.reports > 0 && (
								<strong
									className="observer-total"
									aria-label={`${visibleUsage.reports} turn ${visibleUsage.reports === 1 ? "report" : "reports"}`}
								>
									{visibleUsage.reports}
								</strong>
							)}
						</div>
						{visibleUsage.reports === 0
							? (
								<p className="observer-note">
									{hasTerminalRecord
										? "Clio Coder ended a visible turn without terminal token fields, so the GUI has no token record to graph."
										: "Token fields appear here after Clio Coder ends a turn and reports them."}
								</p>
							)
							: (
								<>
									<ul
										className="token-ledger"
										aria-label="Token fields across visible terminal records"
									>
										{USAGE_FIELDS.map((field) => {
											const value = visibleUsage.totals[field.key];
											return (
												<li
													className={`token-ledger__row token-ledger__row--${field.key}`}
													key={field.key}
												>
													<dl className="token-ledger__fact">
														<dt title={field.description}>
															<span>{field.label}</span>
															<code>{field.key}</code>
														</dt>
														<dd>{formatTokenCount(value)}</dd>
													</dl>
													<span
														className="token-ledger__track"
														aria-hidden="true"
													>
														<span
															style={{
																width: usageBarWidth(value, maximumUsageField),
															}}
														/>
													</span>
												</li>
											);
										})}
									</ul>
									<p className="observer-method-note">
										Bars compare field counts across terminal reports in the visible record. Fields stay separate
										because providers may account for cached or reasoning tokens differently; the GUI does not infer a
										price.
									</p>
								</>
							)}
					</section>
				)}

				<section
					className="observer-section"
					aria-labelledby="observer-evidence-title"
				>
					<div className="observer-section__heading">
						<div>
							<div className="eyebrow">RECORDED EVIDENCE</div>
							<h3 id="observer-evidence-title">Timeline at a glance</h3>
						</div>
						<strong className="observer-total">{timeline.length}</strong>
					</div>
					{timeline.length === 0
						? (
							<p className="observer-note">
								The first request will begin the evidence record.
							</p>
						)
						: (
							<>
								<ol
									className="evidence-trace"
									aria-label="Most recent recorded events"
								>
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
								{(open?.projection.timelineTruncated === true ||
									open?.clio.session?.replayTruncated === true) && (
									<p className="observer-note">
										This view is shortened; Clio Coder still holds the full context.
									</p>
								)}
							</>
						)}
					{open !== null && (
						<button
							type="button"
							className="button button--quiet observer-map-button"
							aria-pressed={workspaceView === "timeline"}
							onClick={onOpenTimeline}
						>
							<span aria-hidden="true">≣</span>
							{workspaceView === "timeline" ? "Session Timeline open" : "Open Session Timeline"}
						</button>
					)}
				</section>

				<section
					className="observer-section"
					aria-labelledby="observer-sources-title"
				>
					<div className="eyebrow">PROVENANCE</div>
					<h3 id="observer-sources-title">Where each fact came from</h3>
					{sourceCounts.length === 0
						? (
							<p className="observer-note">
								Sources appear here only after Clio Coder records activity.
							</p>
						)
						: (
							<ul className="source-ledger">
								{sourceCounts.map(({ source, count }) => (
									<li key={source}>
										<span
											className={`source-ledger__mark source-ledger__mark--${source}`}
											aria-hidden="true"
										/>
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
}, sameEvidenceRailProps);

function sameUsage(
	previous: WireUsage | undefined,
	next: WireUsage | undefined,
): boolean {
	return previous === next || (
		previous !== undefined && next !== undefined &&
		previous.input === next.input &&
		previous.output === next.output &&
		previous.cacheRead === next.cacheRead &&
		previous.cacheWrite === next.cacheWrite &&
		previous.reasoning === next.reasoning
	);
}

/** The Observatory does not render streamed prose, so prose-only deltas must not reconcile the rail. */
function sameEvidenceTimeline(
	previous: readonly WireTimelineItem[],
	next: readonly WireTimelineItem[],
): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) {
		const before = previous[index];
		const after = next[index];
		if (before === after) continue;
		if (
			before === undefined || after === undefined ||
			before.id !== after.id ||
			before.kind !== after.kind ||
			before.title !== after.title ||
			before.status !== after.status ||
			before.source !== after.source ||
			!sameUsage(before.usage, after.usage)
		) return false;
	}
	return true;
}

function sameEvidenceRailProps(
	previous: EvidenceRailProps,
	next: EvidenceRailProps,
): boolean {
	const previousOpen = previous.state.open;
	const nextOpen = next.state.open;
	const sameOpen = previousOpen === nextOpen || (
		previousOpen !== null && nextOpen !== null &&
		previousOpen.clio === nextOpen.clio &&
		previousOpen.projection.activeTurn === nextOpen.projection.activeTurn &&
		previousOpen.projection.timelineTruncated ===
			nextOpen.projection.timelineTruncated &&
		sameEvidenceTimeline(
			previousOpen.projection.timeline,
			nextOpen.projection.timeline,
		) &&
		previousOpen.configInspection === nextOpen.configInspection &&
		previousOpen.catalogInspection === nextOpen.catalogInspection &&
		previousOpen.usageInspection === nextOpen.usageInspection
	);
	return sameOpen &&
		previous.state.pendingConfigInspect === next.state.pendingConfigInspect &&
		previous.state.pendingCatalogInspect === next.state.pendingCatalogInspect &&
		previous.state.pendingUsageInspect === next.state.pendingUsageInspect &&
		previous.nowMs === next.nowMs &&
		previous.isDrawer === next.isDrawer &&
		previous.drawerOpen === next.drawerOpen &&
		previous.onClose === next.onClose &&
		previous.desktopCollapsed === next.desktopCollapsed &&
		previous.onDesktopCollapse === next.onDesktopCollapse &&
		previous.workspaceView === next.workspaceView &&
		previous.onOpenConfigMap === next.onOpenConfigMap &&
		previous.onOpenCatalog === next.onOpenCatalog &&
		previous.onOpenUsage === next.onOpenUsage &&
		previous.onOpenDispatch === next.onOpenDispatch &&
		previous.onOpenTimeline === next.onOpenTimeline &&
		previous.obscured === next.obscured;
}

function settingFamily(key: string): string {
	return key.split(/[.[]/u, 1)[0] ?? key;
}

function entrySource(entry: WireCustomizationEntry): string {
	if (entry.sourcePath === undefined) return `${entry.scope} scope`;
	const path = formatProjectPath(entry.sourcePath);
	return path === "/" ? "project root" : path;
}

function scopeLabel(scope: string): string {
	switch (scope.toLocaleLowerCase("en-US")) {
		case "project":
			return "Project";
		case "project.local":
			return "Project local";
		case "user":
			return "User";
		case "package":
			return "Package";
		case "extension":
			return "Extension";
		case "cli":
			return "Command line";
		default:
			return scope;
	}
}

function formatContextEstimate(value: number): string {
	return `~${new Intl.NumberFormat().format(value)}`;
}

export const EffectiveClioMap = memo(function EffectiveClioMap({
	inspection,
	pending,
	onRefresh,
	onBack,
}: {
	inspection: WireConfigInspection | null;
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	if (inspection === null) {
		return (
			<section
				className="effective-map effective-map--empty"
				aria-labelledby="effective-clio-coder-title"
				aria-busy={pending}
			>
				<div className="effective-map__empty-instrument" aria-hidden="true">
					<span>01</span>
					<i />
					<span>03</span>
				</div>
				<div>
					<div className="eyebrow">READ-ONLY CLIO CODER INSPECTION</div>
					<h2 id="effective-clio-coder-title">
						Build the map behind Clio Coder's behavior
					</h2>
					<p>
						The Clio Coder desktop app asks Clio Coder which settings, context, rules, hooks, extensions, resources,
						safety, and memory surfaces are effective for this project. Raw values and paths outside the project stay on
						the host.
					</p>
				</div>
				<div className="effective-map__empty-actions">
					<button
						type="button"
						className="button button--primary"
						onClick={onRefresh}
						disabled={pending}
					>
						{pending ? "Inspecting with Clio Coder…" : "Inspect Effective Clio Coder"}
					</button>
					<button
						type="button"
						className="button button--quiet"
						onClick={onBack}
					>
						Back to conversation
					</button>
				</div>
				<p className="effective-map__boundary">
					This command is read-only and runs independently of the live ACP control lane.
				</p>
			</section>
		);
	}

	const categoryGroups = CUSTOMIZATION_CATEGORY_ORDER.map((category) => ({
		category,
		entries: inspection.entries.filter((entry) => entry.category === category),
	})).filter((group) => group.entries.length > 0);
	const settingGroups = [
		...new Set(
			inspection.settings.map((setting) => settingFamily(setting.key)),
		),
	].map((
		family,
	) => ({
		family,
		settings: inspection.settings.filter((setting) => settingFamily(setting.key) === family),
	})).sort((left, right) => left.family.localeCompare(right.family, "en-US"));
	const sourceCounts = new Map<string, number>();
	for (const setting of inspection.settings) {
		const label = SETTING_SOURCE_LABELS[setting.source];
		sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
	}
	for (const entry of inspection.entries) {
		const label = scopeLabel(entry.scope);
		sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
	}
	const sources = [...sourceCounts.entries()].sort((left, right) =>
		right[1] - left[1] || left[0].localeCompare(right[0])
	);
	const reloads = (Object.keys(RELOAD_PRESENTATION) as WireCustomizationReloadClass[]).map((
		reloadClass,
	) => ({
		reloadClass,
		count: inspection.entries.filter((entry) => entry.reloadClass === reloadClass).length,
	})).filter((entry) => entry.count > 0);
	const contextTokens = inspection.entries.reduce(
		(total, entry) => total + (entry.contextCostTokens ?? 0),
		0,
	);
	const issueTotal = inspection.issueCounts.reduce(
		(total, issue) => total + issue.count,
		0,
	);
	const restartCount = inspection.entries.filter((entry) => entry.reloadClass === "restart").length;

	return (
		<section
			className="effective-map"
			aria-labelledby="effective-clio-coder-title"
		>
			<header className="effective-map__masthead">
				<div>
					<div className="eyebrow">
						EFFECTIVE CLIO CODER · REPORTED BY CLIO CODER
					</div>
					<h2 id="effective-clio-coder-title">
						Why Clio Coder behaves this way
					</h2>
					<p>
						A bounded snapshot of the layers Clio Coder says it loaded, where they came from, and when a change takes
						effect.
					</p>
				</div>
				<div className="effective-map__masthead-actions">
					<span>
						{pending ? "Refreshing inspection…" : `Inspected ${formatTimestamp(inspection.inspectedAt)}`}
					</span>
					<div>
						<button
							type="button"
							className="button button--quiet"
							onClick={onBack}
						>
							Back to conversation
						</button>
						<button
							type="button"
							className="button button--primary"
							onClick={onRefresh}
							disabled={pending}
						>
							Refresh map
						</button>
					</div>
				</div>
			</header>

			<dl
				className="effective-map__summary"
				aria-label="Effective Clio Coder inspection summary"
			>
				<div>
					<dt>Effective setting facts</dt>
					<dd>{inspection.settings.length}</dd>
					<dd className="effective-map__summary-note">
						{inspection.settingsTruncated ? "bounded result" : "reported in this snapshot"}
					</dd>
				</div>
				<div>
					<dt>Customization surfaces</dt>
					<dd>{inspection.entries.length}</dd>
					<dd className="effective-map__summary-note">
						{categoryGroups.length} represented categories
					</dd>
				</div>
				<div>
					<dt>Estimated context cost</dt>
					<dd>
						{contextTokens === 0 ? "—" : formatContextEstimate(contextTokens)}
					</dd>
					<dd className="effective-map__summary-note">
						{contextTokens === 0 ? "none reported" : "tokens across costed entries"}
					</dd>
				</div>
				<div>
					<dt>Needs a restart</dt>
					<dd>{restartCount}</dd>
					<dd className="effective-map__summary-note">
						{issueTotal === 0 ? "no reported inspection issues" : `${issueTotal} reported issues`}
					</dd>
				</div>
			</dl>

			<section
				className="effective-map__flow"
				aria-labelledby="effective-flow-title"
			>
				<div className="effective-map__section-heading">
					<div className="eyebrow">INFLUENCE PATH</div>
					<h3 id="effective-flow-title">From source to behavior</h3>
				</div>
				<div className="effective-flow">
					<div className="effective-flow__stage effective-flow__stage--sources">
						<span className="effective-flow__index">01</span>
						<h4>Sources</h4>
						<p>Scopes and setting layers Clio Coder inspected.</p>
						<ul>
							{sources.slice(0, 8).map(([source, count]) => (
								<li key={source}>
									<span>{source}</span>
									<strong>{count}</strong>
								</li>
							))}
						</ul>
					</div>
					<span className="effective-flow__connector" aria-hidden="true">
						→
					</span>
					<div className="effective-flow__stage effective-flow__stage--layers">
						<span className="effective-flow__index">02</span>
						<h4>Loaded layers</h4>
						<p>Bounded surfaces in the effective graph.</p>
						<ul>
							{categoryGroups.map(({ category, entries }) => (
								<li key={category}>
									<code>
										{CUSTOMIZATION_CATEGORY_PRESENTATION[category].short}
									</code>
									<span>
										{CUSTOMIZATION_CATEGORY_PRESENTATION[category].label}
									</span>
									<strong>{entries.length}</strong>
								</li>
							))}
						</ul>
					</div>
					<span className="effective-flow__connector" aria-hidden="true">
						→
					</span>
					<div className="effective-flow__stage effective-flow__stage--timing">
						<span className="effective-flow__index">03</span>
						<h4>Apply timing</h4>
						<p>When Clio Coder says each surface can change behavior.</p>
						<ul>
							{reloads.map(({ reloadClass, count }) => (
								<li key={reloadClass}>
									<span>{RELOAD_PRESENTATION[reloadClass].label}</span>
									<strong>{count}</strong>
									<small>{RELOAD_PRESENTATION[reloadClass].description}</small>
								</li>
							))}
						</ul>
					</div>
				</div>
			</section>

			<div className="effective-map__catalogs">
				<section
					className="config-catalog"
					aria-labelledby="customization-catalog-title"
				>
					<div className="effective-map__section-heading">
						<div>
							<div className="eyebrow">CUSTOMIZATION INVENTORY</div>
							<h3 id="customization-catalog-title">What Clio Coder loaded</h3>
						</div>
						<strong>{inspection.entries.length}</strong>
					</div>
					{categoryGroups.length === 0
						? (
							<p className="config-catalog__empty">
								Clio Coder reported no customization entries for this project.
							</p>
						)
						: categoryGroups.map(({ category, entries }, categoryIndex) => {
							const presentation = CUSTOMIZATION_CATEGORY_PRESENTATION[category];
							return (
								<details
									className="config-category"
									open={categoryIndex < 2}
									key={category}
								>
									<summary>
										<code>{presentation.short}</code>
										<span>
											<strong>{presentation.label}</strong>
											<small>{presentation.description}</small>
										</span>
										<b>{entries.length}</b>
									</summary>
									<ul className="config-entry-list">
										{entries.map((entry, entryIndex) => (
											<li
												className="config-entry"
												key={`${entry.id}:${entry.scope}:${entryIndex}`}
											>
												<div className="config-entry__heading">
													<div>
														<strong>{entry.id}</strong>
														<span>{entrySource(entry)}</span>
													</div>
													{entry.hash && (
														<code title="Content fingerprint">
															#{entry.hash}
														</code>
													)}
												</div>
												<div className="config-entry__badges">
													<span>
														{RELOAD_PRESENTATION[entry.reloadClass].label}
													</span>
													{entry.trust && <span>{entry.trust}</span>}
													{entry.precedence && <span>{entry.precedence}</span>}
													{entry.contextCostTokens !== undefined && (
														<span>
															{formatContextEstimate(entry.contextCostTokens)} context tokens
														</span>
													)}
												</div>
												{entry.facts.length > 0 && (
													<dl className="config-entry__facts">
														{entry.facts.map((entryFact) => (
															<div key={entryFact.label}>
																<dt>{entryFact.label}</dt>
																<dd>{entryFact.value}</dd>
															</div>
														))}
													</dl>
												)}
											</li>
										))}
									</ul>
								</details>
							);
						})}
					{inspection.entriesTruncated && (
						<p className="config-catalog__note">
							The entry inventory reached the GUI display bound.
						</p>
					)}
				</section>

				<section
					className="settings-catalog"
					aria-labelledby="settings-catalog-title"
				>
					<div className="effective-map__section-heading">
						<div>
							<div className="eyebrow">EFFECTIVE SETTING FACTS</div>
							<h3 id="settings-catalog-title">What each layer set</h3>
						</div>
						<strong>{inspection.settings.length}</strong>
					</div>
					<p className="settings-catalog__lede">
						Exact values appear only for the small public-safe set and non-sensitive numbers or booleans. Everything
						else says configured without copying the raw value.
					</p>
					{settingGroups.length === 0
						? (
							<p className="config-catalog__empty">
								Clio Coder reported only built-in defaults.
							</p>
						)
						: settingGroups.map(({ family, settings }, groupIndex) => (
							<details
								className="setting-family"
								open={family === "orchestrator" || family === "autonomy" ||
									groupIndex === 0}
								key={family}
							>
								<summary>
									<code>{family}</code>
									<span>{settings.length}</span>
								</summary>
								<div className="setting-table-wrap">
									<table>
										<thead>
											<tr>
												<th>Exact key</th>
												<th>Effective value</th>
												<th>Source</th>
											</tr>
										</thead>
										<tbody>
											{settings.map((setting) => (
												<tr key={setting.key}>
													<th scope="row">
														<code>{setting.key}</code>
													</th>
													<td className={`is-${setting.valueKind}`}>
														{setting.value}
													</td>
													<td>{SETTING_SOURCE_LABELS[setting.source]}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</details>
						))}
					{inspection.settingsTruncated && (
						<p className="config-catalog__note">
							The setting inventory reached the GUI display bound.
						</p>
					)}
				</section>
			</div>

			{inspection.issueCounts.length > 0 && (
				<section
					className="config-issues"
					aria-labelledby="config-issues-title"
				>
					<div>
						<div className="eyebrow">INSPECTION ISSUES</div>
						<h3 id="config-issues-title">
							Clio Coder could not fully inspect every surface
						</h3>
						<p>
							Raw diagnostic text and native paths remain on the host. Use the CLI when the exact repair detail is
							needed.
						</p>
					</div>
					<ul>
						{inspection.issueCounts.map((issue) => (
							<li key={issue.surface}>
								<span>{issue.surface}</span>
								<strong>{issue.count}</strong>
							</li>
						))}
					</ul>
					{inspection.issuesTruncated && <p>The issue summary reached the GUI display bound.</p>}
				</section>
			)}

			<footer className="effective-map__method">
				<strong>Boundary note</strong>
				<p>
					Project sources use project-relative paths. User, package, and extension locations are named only by scope.
					Values marked configured are deliberately redacted; this map never receives credentials, raw environment
					values, stderr, or generic CLI detail.
				</p>
			</footer>
		</section>
	);
});

type CatalogTab = "agents" | "skills" | "library" | "extensions" | "verifiers";

const CATALOG_TABS: ReadonlyArray<
	{ id: CatalogTab; label: string; note: string }
> = [
	{ id: "agents", label: "Agents", note: "Discovered recipes" },
	{ id: "skills", label: "Skills", note: "Installed workflows" },
	{ id: "library", label: "Library", note: "Available resources" },
	{ id: "extensions", label: "Extensions", note: "Installed packages" },
	{ id: "verifiers", label: "Verifiers", note: "Project checks" },
];

function catalogLabel(value: string): string {
	return value.replaceAll("-", " ").replaceAll(".", " · ").replace(
		/^./u,
		(letter) => letter.toLocaleUpperCase("en-US"),
	);
}

function includesCatalogQuery(
	query: string,
	values: readonly string[],
): boolean {
	if (query.length === 0) return true;
	return values.some((value) => value.toLocaleLowerCase("en-US").includes(query));
}

function AgentCatalogCard({ agent }: { agent: WireCatalogAgent }) {
	const maximum = agent.budget.maximumToolCalls === null
		? `${agent.budget.toolCalls}`
		: `${agent.budget.toolCalls}–${agent.budget.maximumToolCalls}`;
	return (
		<article className="catalog-card catalog-card--agent">
			<header className="catalog-card__header">
				<div>
					<div className="eyebrow">
						{catalogLabel(agent.category)} · {catalogLabel(agent.source)}
					</div>
					<h3>{agent.name}</h3>
					<code>{agent.id}</code>
				</div>
				<span
					className={`catalog-card__signal catalog-card__signal--${agent.latency}`}
				>
					{catalogLabel(agent.latency)}
				</span>
			</header>
			<p className="catalog-card__description">{agent.description}</p>
			<dl className="catalog-card__facts">
				<div>
					<dt>Capability</dt>
					<dd>{catalogLabel(agent.capability)}</dd>
				</div>
				<div>
					<dt>Project context</dt>
					<dd>{catalogLabel(agent.contextTier)}</dd>
				</div>
				<div>
					<dt>Tool-call budget</dt>
					<dd>{maximum}</dd>
				</div>
				<div>
					<dt>Read reserve</dt>
					<dd>{agent.budget.readReserve}</dd>
				</div>
			</dl>
			{agent.skills.length > 0 && (
				<div className="catalog-card__binding">
					<strong>Bound skills</strong>
					<div className="catalog-chips">
						{agent.skills.map((skill) => <span key={skill}>{skill}</span>)}
					</div>
				</div>
			)}
			<details className="catalog-card__details">
				<summary>
					{agent.tools.length} declared tool surface{agent.tools.length === 1 ? "" : "s"}
				</summary>
				<div className="catalog-chips catalog-chips--tools">
					{agent.tools.map((tool) => <span key={tool}>{tool}</span>)}
				</div>
			</details>
			<footer className="catalog-card__footer">
				<span>Result contract</span>
				<code>{agent.resultKind}</code>
				<span>
					{agent.budget.synthesis ? "Text synthesis at boundary" : "Stops at boundary"}
				</span>
			</footer>
		</article>
	);
}

function SkillCatalogCard({ skill }: { skill: WireCatalogSkill }) {
	return (
		<article className="catalog-card catalog-card--skill">
			<header className="catalog-card__header">
				<div>
					<div className="eyebrow">
						{catalogLabel(skill.scope)} · {catalogLabel(skill.source)}
					</div>
					<h3>{skill.name}</h3>
				</div>
				<span
					className={`catalog-card__signal ${skill.trusted ? "is-trusted" : "is-untrusted"}`}
				>
					{skill.trusted ? "Trusted" : "Not trusted"}
				</span>
			</header>
			<p className="catalog-card__description">{skill.description}</p>
			<dl className="catalog-card__facts catalog-card__facts--three">
				<div>
					<dt>Precedence</dt>
					<dd>{skill.precedence}</dd>
				</div>
				<div>
					<dt>Model invocation</dt>
					<dd>{skill.modelInvocable ? "Allowed" : "Operator only"}</dd>
				</div>
				<div>
					<dt>Reported issues</dt>
					<dd>{skill.issueCount}</dd>
				</div>
			</dl>
			<footer className="catalog-card__footer">
				<span>Installed inventory only</span>
				<span>Body and native location remain host-side</span>
			</footer>
		</article>
	);
}

function LibraryCatalogCard({ entry }: { entry: WireCatalogLibraryEntry }) {
	return (
		<article className="catalog-card catalog-card--library">
			<header className="catalog-card__header">
				<div>
					<div className="eyebrow">
						{catalogLabel(entry.kind)} · {catalogLabel(entry.origin)}
					</div>
					<h3>{entry.name}</h3>
				</div>
				<span
					className={`catalog-card__signal catalog-card__signal--audit-${entry.audit}`}
				>
					Audit {catalogLabel(entry.audit)}
				</span>
			</header>
			<p className="catalog-card__description">{entry.description}</p>
			<dl className="catalog-card__facts catalog-card__facts--three">
				<div>
					<dt>Version</dt>
					<dd>{entry.version ?? "Not reported"}</dd>
				</div>
				<div>
					<dt>Category</dt>
					<dd>
						{entry.category === null ? "Uncategorized" : catalogLabel(entry.category)}
					</dd>
				</div>
				<div>
					<dt>Resource kind</dt>
					<dd>{catalogLabel(entry.kind)}</dd>
				</div>
			</dl>
			<footer className="catalog-card__footer">
				<span>Available resource</span>
				<span>
					Installation review is not exposed in this read-only surface
				</span>
			</footer>
		</article>
	);
}

function ExtensionCatalogCard(
	{ extension }: { extension: WireCatalogExtension },
) {
	const state = !extension.enabled ? "Disabled" : extension.effective ? "Active" : "Shadowed";
	const stateClass = !extension.enabled ? "disabled" : extension.effective ? "active" : "shadowed";
	return (
		<article className="catalog-card catalog-card--extension">
			<header className="catalog-card__header">
				<div>
					<div className="eyebrow">
						{catalogLabel(extension.scope)} · Extension package
					</div>
					<h3>{extension.name}</h3>
					<code>{extension.id}</code>
				</div>
				<span
					className={`catalog-card__signal catalog-card__signal--extension-${stateClass}`}
				>
					{state}
				</span>
			</header>
			<p className="catalog-card__description">{extension.description}</p>
			<dl className="catalog-card__facts catalog-card__facts--three">
				<div>
					<dt>Version</dt>
					<dd>{extension.version}</dd>
				</div>
				<div>
					<dt>Precedence</dt>
					<dd>
						{extension.effective ? "Winner" : `Shadowed by ${catalogLabel(extension.overriddenBy ?? "higher")}`}
					</dd>
				</div>
				<div>
					<dt>Reported issues</dt>
					<dd>{extension.issueCount}</dd>
				</div>
			</dl>
			<div className="catalog-card__binding">
				<strong>Contributed resource kinds</strong>
				{extension.resources.length === 0
					? (
						<p className="catalog-card__empty-binding">
							No resource roots declared
						</p>
					)
					: (
						<div className="catalog-chips">
							{extension.resources.map((resource) => <span key={resource}>{catalogLabel(resource)}</span>)}
						</div>
					)}
			</div>
			<footer className="catalog-card__footer">
				<span>
					{extension.scope === "project" ? "Project-scoped package" : "User-scoped package"}
				</span>
				<span>Native roots and lifecycle mutations remain host-side</span>
			</footer>
		</article>
	);
}

function CatalogCollectionFailure(
	{ label, onRefresh }: { label: string; onRefresh(): void },
) {
	return (
		<div className="catalog-state catalog-state--failed" role="status">
			<div className="catalog-state__instrument" aria-hidden="true">×</div>
			<div>
				<h3>{label} could not be read</h3>
				<p>
					The other collections remain usable. Clio Coder's raw diagnostic stayed on the local host rather than crossing
					into this page.
				</p>
			</div>
			<button
				type="button"
				className="button button--quiet"
				onClick={onRefresh}
			>
				Retry all catalogs
			</button>
		</div>
	);
}

function CatalogEmptyCollection(
	{ label, query }: { label: string; query: string },
) {
	return (
		<div className="catalog-state">
			<div className="catalog-state__instrument" aria-hidden="true">0</div>
			<div>
				<h3>
					{query.length > 0 ? "No matching resources" : `No ${label} reported`}
				</h3>
				<p>
					{query.length > 0
						? "Try a broader name, description, category, capability, or provenance term."
						: "This is an explicit empty result from the corresponding Clio Coder listing, not a guessed absence."}
				</p>
			</div>
		</div>
	);
}

export const ClioCatalog = memo(function ClioCatalog({
	inspection,
	pending,
	onRefresh,
	onBack,
}: {
	inspection: WireCatalogInspection | null;
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	const [tab, setTab] = useState<CatalogTab>("agents");
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(
		query.trim().toLocaleLowerCase("en-US"),
	);

	if (inspection === null) {
		return (
			<section
				className="catalog catalog--empty"
				aria-labelledby="clio-catalog-title"
				aria-busy={pending}
			>
				<div className="catalog__empty-index" aria-hidden="true">
					<span>A</span>
					<span>S</span>
					<span>L</span>
					<span>E</span>
				</div>
				<div>
					<div className="eyebrow">READ-ONLY RESOURCE DISCOVERY</div>
					<h2 id="clio-catalog-title">
						Map the capabilities Clio Coder can actually see
					</h2>
					<p>
						Inspect discovered agents, installed skills and extensions, and available library resources through their
						public JSON interfaces. Verifiers remain explicitly unavailable until Clio Coder offers a typed listing.
					</p>
				</div>
				<div className="catalog__empty-actions">
					<button
						type="button"
						className="button button--primary"
						onClick={onRefresh}
						disabled={pending}
					>
						{pending ? "Reading Clio Coder catalogs…" : "Inspect Clio Coder catalogs"}
					</button>
					<button
						type="button"
						className="button button--quiet"
						onClick={onBack}
					>
						Back to conversation
					</button>
				</div>
				<p className="catalog__boundary">
					Bodies, hashes, diagnostics, native paths, requirement URLs, and arbitrary command output never reach this
					view.
				</p>
			</section>
		);
	}

	const agents = inspection.agents.items.filter((agent) =>
		includesCatalogQuery(deferredQuery, [
			agent.id,
			agent.name,
			agent.description,
			agent.source,
			agent.category,
			agent.capability,
			agent.latency,
			...agent.tags,
			...agent.skills,
			...agent.tools,
		])
	);
	const skills = inspection.skills.items.filter((skill) =>
		includesCatalogQuery(deferredQuery, [
			skill.name,
			skill.description,
			skill.scope,
			skill.source,
		])
	);
	const library = inspection.library.items.filter((entry) =>
		includesCatalogQuery(deferredQuery, [
			entry.kind,
			entry.name,
			entry.description,
			entry.version ?? "",
			entry.category ?? "",
			entry.origin,
			entry.audit,
		])
	);
	const extensions = inspection.extensions.items.filter((extension) =>
		includesCatalogQuery(deferredQuery, [
			extension.id,
			extension.name,
			extension.description,
			extension.version,
			extension.scope,
			extension.enabled ? "enabled" : "disabled",
			extension.effective ? "active" : "shadowed",
			...extension.resources,
		])
	);
	const activeCount = tab === "agents"
		? agents.length
		: tab === "skills"
		? skills.length
		: tab === "library"
		? library.length
		: tab === "extensions"
		? extensions.length
		: 0;
	const activeAvailability = tab === "agents"
		? inspection.agents.availability
		: tab === "skills"
		? inspection.skills.availability
		: tab === "library"
		? inspection.library.availability
		: tab === "extensions"
		? inspection.extensions.availability
		: "available";
	const activeTruncated = tab === "agents"
		? inspection.agents.truncated
		: tab === "skills"
		? inspection.skills.truncated
		: tab === "library"
		? inspection.library.truncated
		: tab === "extensions"
		? inspection.extensions.truncated
		: false;
	function selectTab(nextTab: CatalogTab): void {
		setTab(nextTab);
		setQuery("");
	}
	function moveTab(
		event: KeyboardEvent<HTMLButtonElement>,
		index: number,
	): void {
		let nextIndex: number;
		switch (event.key) {
			case "ArrowLeft":
				nextIndex = (index - 1 + CATALOG_TABS.length) % CATALOG_TABS.length;
				break;
			case "ArrowRight":
				nextIndex = (index + 1) % CATALOG_TABS.length;
				break;
			case "Home":
				nextIndex = 0;
				break;
			case "End":
				nextIndex = CATALOG_TABS.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		const nextTab = CATALOG_TABS[nextIndex];
		if (!nextTab) return;
		selectTab(nextTab.id);
		event.currentTarget.ownerDocument.getElementById(
			`catalog-tab-${nextTab.id}`,
		)?.focus();
	}

	return (
		<section
			className="catalog"
			aria-labelledby="clio-catalog-title"
			aria-busy={pending}
		>
			<header className="catalog__masthead">
				<div>
					<div className="eyebrow">
						CLIO CODER CAPABILITY ATLAS · REPORTED BY CLIO CODER
					</div>
					<h2 id="clio-catalog-title">
						Agents, skills, extensions &amp; resource library
					</h2>
					<p>
						A searchable inventory of what this project can discover—not a fictional control plane.
					</p>
				</div>
				<div className="catalog__masthead-actions">
					<span>
						{pending ? "Refreshing catalogs…" : `Inspected ${formatTimestamp(inspection.inspectedAt)}`}
					</span>
					<div>
						<button
							type="button"
							className="button button--quiet"
							onClick={onBack}
						>
							Back to conversation
						</button>
						<button
							type="button"
							className="button button--primary"
							onClick={onRefresh}
							disabled={pending}
						>
							Refresh catalogs
						</button>
					</div>
				</div>
			</header>

			<dl
				className="catalog__summary"
				aria-label="Clio Coder catalog inspection summary"
			>
				<div>
					<dt>Agent recipes</dt>
					<dd>
						{inspection.agents.availability === "available" ? inspection.agents.items.length : "—"}
					</dd>
					<dd className="catalog__summary-note">
						{catalogLabel(inspection.agents.availability)}
					</dd>
				</div>
				<div>
					<dt>Installed skills</dt>
					<dd>
						{inspection.skills.availability === "available" ? inspection.skills.items.length : "—"}
					</dd>
					<dd className="catalog__summary-note">
						{inspection.skills.issueCount} reported loader {inspection.skills.issueCount === 1 ? "issue" : "issues"}
					</dd>
				</div>
				<div>
					<dt>Library resources</dt>
					<dd>
						{inspection.library.availability === "available" ? inspection.library.items.length : "—"}
					</dd>
					<dd className="catalog__summary-note">
						{catalogLabel(inspection.library.availability)}
					</dd>
				</div>
				<div>
					<dt>Extensions</dt>
					<dd>
						{inspection.extensions.availability === "available" ? inspection.extensions.items.length : "—"}
					</dd>
					<dd className="catalog__summary-note">
						{inspection.extensions.issueCount} reported package{" "}
						{inspection.extensions.issueCount === 1 ? "issue" : "issues"}
					</dd>
				</div>
				<div>
					<dt>Verifier listing</dt>
					<dd>—</dd>
					<dd className="catalog__summary-note">Typed interface required</dd>
				</div>
			</dl>

			<div className="catalog__workbench">
				<div
					className="catalog__tabs"
					role="tablist"
					aria-label="Catalog collections"
				>
					{CATALOG_TABS.map((item, index) => (
						<button
							type="button"
							role="tab"
							id={`catalog-tab-${item.id}`}
							aria-controls="catalog-panel"
							aria-selected={tab === item.id}
							tabIndex={tab === item.id ? 0 : -1}
							key={item.id}
							onClick={() => selectTab(item.id)}
							onKeyDown={(event) => moveTab(event, index)}
						>
							<span>{item.label}</span>
							<small>{item.note}</small>
						</button>
					))}
				</div>
				<div className="catalog__query">
					<label htmlFor="catalog-search">Filter this collection</label>
					<div>
						<span aria-hidden="true">⌕</span>
						<input
							id="catalog-search"
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={`Search ${
								CATALOG_TABS.find((item) => item.id === tab)?.label
									.toLocaleLowerCase("en-US") ?? "catalog"
							}`}
							disabled={tab === "verifiers" || activeAvailability === "failed"}
						/>
						{query.length > 0 && (
							<button
								type="button"
								onClick={() => setQuery("")}
								aria-label="Clear catalog filter"
							>
								×
							</button>
						)}
					</div>
					<small>
						{tab === "verifiers"
							? "No typed rows to search"
							: activeAvailability === "failed"
							? "This collection is unavailable"
							: `${activeCount} visible ${activeCount === 1 ? "record" : "records"}`}
					</small>
				</div>
			</div>

			<section
				className="catalog__panel"
				id="catalog-panel"
				role="tabpanel"
				aria-labelledby={`catalog-tab-${tab}`}
			>
				{tab === "verifiers"
					? (
						<div className="catalog-verifier-boundary">
							<div
								className="catalog-verifier-boundary__track"
								aria-hidden="true"
							>
								<span>DISCOVER</span>
								<i />
								<span>TYPE</span>
								<i />
								<span>RENDER</span>
							</div>
							<div>
								<div className="eyebrow">HONEST UPSTREAM BOUNDARY</div>
								<h3>
									Verifier discovery is real, but it is not machine-readable yet
								</h3>
								<p>
									Clio Coder exposes <code>clio-coder verifiers discover</code>{" "}
									as a formatted authoring preview. The GUI will not scrape that table or pretend its argv, cwd,
									timeout, tags, and authority are typed facts.
								</p>
								<p>
									Once Clio Coder publishes a JSON listing, this tab can become a real checks catalog with preview and
									confirmation states for mutations.
								</p>
							</div>
						</div>
					)
					: activeAvailability === "failed"
					? (
						<CatalogCollectionFailure
							label={CATALOG_TABS.find((item) => item.id === tab)?.label ??
								"Catalog"}
							onRefresh={onRefresh}
						/>
					)
					: activeCount === 0
					? <CatalogEmptyCollection label={tab} query={deferredQuery} />
					: (
						<div className={`catalog-grid catalog-grid--${tab}`}>
							{tab === "agents" &&
								agents.map((agent) => <AgentCatalogCard agent={agent} key={agent.id} />)}
							{tab === "skills" &&
								skills.map((skill) => <SkillCatalogCard skill={skill} key={skill.name} />)}
							{tab === "library" &&
								library.map((entry) => (
									<LibraryCatalogCard
										entry={entry}
										key={`${entry.kind}:${entry.name}`}
									/>
								))}
							{tab === "extensions" &&
								extensions.map((extension) => (
									<ExtensionCatalogCard
										extension={extension}
										key={`${extension.scope}:${extension.id}`}
									/>
								))}
						</div>
					)}
				{activeTruncated && tab !== "verifiers" && (
					<p className="catalog__truncated" role="note">
						This collection reached the GUI display bound. Refreshing cannot reveal omitted rows until the catalog is
						narrowed.
					</p>
				)}
			</section>

			<footer className="catalog__method">
				<strong>Read-only boundary</strong>
				<p>
					Bodies, hashes, native paths, source URLs, requirements, and raw diagnostics stay host-side. This atlas can
					explain discovered capability. It cannot run an agent directly, activate a skill, install a library resource,
					or mutate an extension package because those operations need explicit review, progress, terminal outcomes, and
					recovery semantics.
				</p>
			</footer>
		</section>
	);
});

const usageCurrency = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	// Cost is already a Clio Coder-reported number. Preserve its useful precision
	// instead of rounding it to a Workbench-selected accounting increment.
	maximumSignificantDigits: 15,
});

function formatUsageCost(value: number): string {
	return usageCurrency.format(value);
}

function usageFieldWidth(value: number, maximum: number): string {
	if (value === 0 || maximum === 0) return "0%";
	return `${Math.max(1.5, Math.min(100, (value / maximum) * 100))}%`;
}

function usageStoreLabel(value: "available" | "missing"): string {
	return value === "available" ? "Store read" : "Store missing";
}

function UsageEmptyState({ pending, onRefresh, onBack }: {
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	return (
		<section
			className="usage-notebook usage-notebook--empty"
			aria-labelledby="usage-notebook-title"
			aria-busy={pending}
		>
			<div className="usage-notebook__empty-dial" aria-hidden="true">
				<span>30</span>
				<small>DAYS</small>
			</div>
			<div>
				<div className="eyebrow">PROJECT HISTORY · READ ONLY</div>
				<h2 id="usage-notebook-title">
					Read the work Clio Coder has recorded here
				</h2>
				<p>
					This record asks Clio Coder for project-filtered sessions, dispatch receipts, model usage, tools, skills,
					recipes, and safe opportunity counts across a fixed 30-day window.
				</p>
			</div>
			<div className="usage-notebook__empty-actions">
				<button
					type="button"
					className="button button--primary"
					onClick={onRefresh}
					disabled={pending}
				>
					{pending ? "Reading project history…" : "Inspect 30-day usage"}
				</button>
				<button type="button" className="button button--quiet" onClick={onBack}>
					Back to conversation
				</button>
			</div>
			<p className="usage-notebook__boundary">
				Raw prompts, suggestions, shell shapes, session and run identifiers, native paths, global memory, evidence tags,
				and diagnostics stay on the host.
			</p>
		</section>
	);
}

export const UsageNotebook = memo(function UsageNotebook({
	inspection,
	pending,
	onRefresh,
	onBack,
}: {
	inspection: WireUsageInspection | null;
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	if (inspection === null) {
		return (
			<UsageEmptyState
				pending={pending}
				onRefresh={onRefresh}
				onBack={onBack}
			/>
		);
	}

	const totals = inspection.totals;
	const maximumUsageField = totals === null ? 0 : USAGE_FIELDS.reduce(
		(maximum, field) => Math.max(maximum, totals[field.key]),
		0,
	);
	const maximumModelTokens = inspection.models.reduce(
		(maximum, model) => Math.max(maximum, model.totalTokens),
		0,
	);
	const activatedSkills = inspection.skills.filter((skill) => skill.observedInWindow);
	const dormantSkills = inspection.skills.length - activatedSkills.length;
	const totalOpportunityCount = inspection.opportunities.reduce(
		(total, item) => total + item.count,
		0,
	);
	const storesComplete = inspection.stores.sessions === "available" &&
		inspection.stores.dispatchReceipts === "available";

	return (
		<section
			className="usage-notebook"
			aria-labelledby="usage-notebook-title"
			aria-busy={pending}
		>
			<header className="usage-notebook__masthead">
				<div>
					<div className="eyebrow">
						CLIO CODER USAGE RECORD · EXPERIMENTAL SCHEMA
					</div>
					<h2 id="usage-notebook-title">Thirty days of work in this project</h2>
					<p>
						{formatTimestamp(inspection.windowFrom)} through {formatTimestamp(inspection.windowTo)}{" "}
						· figures are reported by Clio Coder, not inferred from the visible conversation.
					</p>
				</div>
				<div className="usage-notebook__masthead-actions">
					<span>
						{pending ? "Refreshing history…" : `Inspected ${formatTimestamp(inspection.inspectedAt)}`}
					</span>
					<div>
						<button
							type="button"
							className="button button--quiet"
							onClick={onBack}
						>
							Back to conversation
						</button>
						<button
							type="button"
							className="button button--primary"
							onClick={onRefresh}
							disabled={pending}
						>
							Refresh record
						</button>
					</div>
				</div>
			</header>

			<dl
				className="usage-notebook__summary"
				aria-label="Thirty-day project usage summary"
			>
				<div>
					<dt>Total tokens</dt>
					<dd>
						{totals === null ? "—" : formatTokenCount(totals.totalTokens)}
					</dd>
					<dd className="usage-notebook__summary-note">
						{totals === null ? "No token aggregate reported" : `${totals.apiCalls.toLocaleString()} API calls`}
					</dd>
				</div>
				<div>
					<dt>Clio Coder-reported cost</dt>
					<dd>{totals === null ? "—" : formatUsageCost(totals.costUsd)}</dd>
					<dd className="usage-notebook__summary-note">
						Recorded cost, never a GUI estimate
					</dd>
				</div>
				<div
					className={inspection.stores.sessions === "missing" ? "is-missing" : undefined}
				>
					<dt>Sessions</dt>
					<dd>
						{inspection.sessionCount === null ? "—" : inspection.sessionCount.toLocaleString()}
					</dd>
					<dd className="usage-notebook__summary-note">
						{usageStoreLabel(inspection.stores.sessions)}
					</dd>
				</div>
				<div
					className={inspection.stores.dispatchReceipts === "missing" ? "is-missing" : undefined}
				>
					<dt>Dispatch runs</dt>
					<dd>
						{inspection.dispatchRunCount === null ? "—" : inspection.dispatchRunCount.toLocaleString()}
					</dd>
					<dd className="usage-notebook__summary-note">
						{usageStoreLabel(inspection.stores.dispatchReceipts)}
					</dd>
				</div>
			</dl>

			{!storesComplete && (
				<p className="usage-notebook__store-note" role="note">
					A dash means Clio Coder could not find that local history store. It does not mean zero activity.
				</p>
			)}

			<div className="usage-notebook__grid">
				<section
					className="usage-record usage-record--tokens"
					aria-labelledby="usage-token-title"
				>
					<header className="usage-record__heading">
						<div>
							<div className="eyebrow">TOKEN COMPOSITION</div>
							<h3 id="usage-token-title">Provider fields kept separate</h3>
						</div>
						<strong>
							{totals === null ? "NO REPORT" : `${totals.apiCalls.toLocaleString()} CALLS`}
						</strong>
					</header>
					{totals === null
						? (
							<p className="usage-record__empty">
								Clio Coder reported no token aggregate for this window. Store availability and resource observations
								remain visible independently.
							</p>
						)
						: (
							<>
								<ul className="usage-token-ledger">
									{USAGE_FIELDS.map((field) => (
										<li
											key={field.key}
											className={`usage-token-ledger__row is-${field.key}`}
										>
											<div>
												<span>{field.label}</span>
												<strong>{formatTokenCount(totals[field.key])}</strong>
											</div>
											<span
												className="usage-token-ledger__track"
												aria-hidden="true"
											>
												<span
													style={{
														width: usageFieldWidth(
															totals[field.key],
															maximumUsageField,
														),
													}}
												/>
											</span>
										</li>
									))}
								</ul>
								<dl
									className="usage-origin-ledger"
									aria-label="Clio Coder usage origins"
								>
									<div>
										<dt>Turns</dt>
										<dd>
											{totals.turns === null ? "not split" : totals.turns.toLocaleString()}
										</dd>
									</div>
									<div>
										<dt>Side questions</dt>
										<dd>{totals.sideQuestions.toLocaleString()}</dd>
									</div>
									<div>
										<dt>Handoffs</dt>
										<dd>{totals.handoffs.toLocaleString()}</dd>
									</div>
								</dl>
							</>
						)}
					<p className="usage-record__method">
						Bars compare token fields with one another; they are not additive percentages. Provider accounting can
						overlap cache and reasoning fields.
					</p>
				</section>

				<section
					className="usage-record usage-record--models"
					aria-labelledby="usage-model-title"
				>
					<header className="usage-record__heading">
						<div>
							<div className="eyebrow">MODEL ATTRIBUTION</div>
							<h3 id="usage-model-title">Models that did the work</h3>
						</div>
						<strong>{inspection.models.length.toLocaleString()} MODELS</strong>
					</header>
					{inspection.models.length === 0
						? (
							<p className="usage-record__empty">
								No project-filtered model rows were reported in this window.
							</p>
						)
						: (
							<ol className="usage-model-ledger">
								{inspection.models.map((model) => (
									<li key={`${model.provider}:${model.model}`}>
										<div className="usage-model-ledger__identity">
											<span>{model.provider}</span>
											<strong>{model.model}</strong>
										</div>
										<div className="usage-model-ledger__measure">
											<span>{model.totalTokens.toLocaleString()} tokens</span>
											<span>
												{formatUsageCost(model.costUsd)} · {model.apiCalls.toLocaleString()} calls
											</span>
										</div>
										<span
											className="usage-model-ledger__track"
											aria-hidden="true"
										>
											<span
												style={{
													width: usageFieldWidth(
														model.totalTokens,
														maximumModelTokens,
													),
												}}
											/>
										</span>
									</li>
								))}
							</ol>
						)}
					{inspection.modelsTruncated && (
						<p className="usage-record__bounded">
							Model rows reached the display bound.
						</p>
					)}
				</section>

				<section
					className="usage-record usage-record--tools"
					aria-labelledby="usage-tool-title"
				>
					<header className="usage-record__heading">
						<div>
							<div className="eyebrow">TOOL OBSERVATIONS</div>
							<h3 id="usage-tool-title">Typed outcomes, not command shapes</h3>
						</div>
						<strong>{inspection.tools.length.toLocaleString()} TOOLS</strong>
					</header>
					{inspection.tools.length === 0
						? (
							<p className="usage-record__empty">
								No project-filtered top-tool rows were reported.
							</p>
						)
						: (
							<div
								className="usage-tool-table"
								role="table"
								aria-label="Project tool outcomes"
							>
								<div role="row" className="usage-tool-table__header">
									<span role="columnheader">Tool</span>
									<span role="columnheader">Calls</span>
									<span role="columnheader">OK</span>
									<span role="columnheader">Errors</span>
									<span role="columnheader">Blocked</span>
								</div>
								{inspection.tools.map((tool) => (
									<div role="row" key={tool.name}>
										<strong role="cell">{tool.name}</strong>
										<span role="cell">{tool.calls.toLocaleString()}</span>
										<span role="cell">{tool.successful.toLocaleString()}</span>
										<span role="cell">{tool.errors.toLocaleString()}</span>
										<span role="cell">{tool.blocked.toLocaleString()}</span>
									</div>
								))}
							</div>
						)}
					{inspection.toolsTruncated && (
						<p className="usage-record__bounded">
							Tool rows reached the display bound.
						</p>
					)}
				</section>

				<section
					className="usage-record usage-record--practice"
					aria-labelledby="usage-practice-title"
				>
					<header className="usage-record__heading">
						<div>
							<div className="eyebrow">WORKING PRACTICE</div>
							<h3 id="usage-practice-title">
								Skills, recipes &amp; reusable patterns
							</h3>
						</div>
						<strong>{totalOpportunityCount.toLocaleString()} SIGNALS</strong>
					</header>
					<div className="usage-practice-grid">
						<section aria-labelledby="usage-skills-title">
							<div className="usage-practice-grid__heading">
								<h4 id="usage-skills-title">Skill activation</h4>
								<span>
									{activatedSkills.length} active · {dormantSkills} unobserved
								</span>
							</div>
							{inspection.skills.length === 0
								? (
									<p className="usage-record__empty">
										No skill inventory was reported.
									</p>
								)
								: (
									<ul className="usage-skill-ledger">
										{inspection.skills.map((skill) => (
											<li
												key={skill.name}
												className={skill.observedInWindow ? "is-active" : "is-dormant"}
											>
												<span>{skill.name}</span>
												<strong>
													{skill.observedInWindow ? skill.activations.toLocaleString() : "not observed"}
												</strong>
											</li>
										))}
									</ul>
								)}
						</section>
						<section aria-labelledby="usage-recipes-title">
							<div className="usage-practice-grid__heading">
								<h4 id="usage-recipes-title">Agent recipes</h4>
								<span>{inspection.recipes.length} observed</span>
							</div>
							{inspection.recipes.length === 0
								? (
									<p className="usage-record__empty">
										No recipe runs were reported.
									</p>
								)
								: (
									<ul className="usage-recipe-ledger">
										{inspection.recipes.map((recipe) => (
											<li key={recipe.agentId}>
												<span>{recipe.agentId}</span>
												<strong>{recipe.runs.toLocaleString()} runs</strong>
											</li>
										))}
									</ul>
								)}
							<div className="usage-opportunity-ledger">
								{inspection.opportunities.map((opportunity) => (
									<div key={opportunity.kind}>
										<span>
											{opportunity.kind === "workflow-distiller" ? "Workflow patterns" : "Recipe candidates"}
										</span>
										<strong>{opportunity.count.toLocaleString()}</strong>
									</div>
								))}
							</div>
						</section>
					</div>
					{(inspection.skillsTruncated || inspection.recipesTruncated) && (
						<p className="usage-record__bounded">
							One or more practice inventories reached the display bound.
						</p>
					)}
				</section>
			</div>

			<section
				className="usage-boundaries"
				aria-labelledby="usage-boundaries-title"
			>
				<div>
					<div className="eyebrow">NEXT TYPED BRIDGES</div>
					<h3 id="usage-boundaries-title">
						Historical surfaces still waiting on safe project contracts
					</h3>
					<p>
						The GUI exposes a boundary instead of scraping formatted output or leaking global records into this project.
					</p>
				</div>
				<ul>
					<li>
						<strong>Evidence</strong>
						<span>No JSON listing; formatted rows stay host-side.</span>
					</li>
					<li>
						<strong>Evaluations</strong>
						<span>JSON exists only after an eval ID is already known.</span>
					</li>
					<li>
						<strong>Traces</strong>
						<span>The run listing is global and carries raw requests.</span>
					</li>
					<li>
						<strong>Fleet</strong>
						<span>
							Global status lives in Dispatch and is never folded into this project record.
						</span>
					</li>
				</ul>
			</section>

			<footer className="usage-notebook__method">
				<strong>Projection boundary</strong>
				<p>
					Only aggregates whose Clio Coder implementation applies the trusted project root are retained. Global audit,
					failure-tag, memory, and evidence rows are discarded; opportunity suggestions are reduced to counts. This is a
					cached read-only snapshot and refreshes only when requested.
				</p>
			</footer>
		</section>
	);
});

const FLEET_EVIDENCE_PRESENTATION: Record<
	WireFleetInspectionRun["evidence"]["state"],
	{ readonly label: string; readonly tone: string }
> = {
	pending: { label: "Receipt pending", tone: "warning" },
	verified: { label: "Receipt verified", tone: "success" },
	failed: { label: "Integrity failed", tone: "error" },
	unavailable: { label: "Receipt unavailable", tone: "neutral" },
};

function FleetRunsEmptyState({ pending, onRefresh, onBack }: {
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	return (
		<section
			className="fleet-journal fleet-journal--empty"
			aria-labelledby="fleet-journal-title"
			aria-busy={pending}
		>
			<div className="fleet-journal__empty-spine" aria-hidden="true">
				<span>01</span>
				<span>02</span>
				<span>03</span>
			</div>
			<div>
				<div className="eyebrow">
					DURABLE RUN RECORD · INSTALLATION-WIDE · READ ONLY
				</div>
				<h2 id="fleet-journal-title">
					Inspect recent Clio Coder runs and their event journals
				</h2>
				<p>
					Clio Coder selects a bounded newest-first window from its durable run ledger. The GUI receives journal events,
					receipt trust, routing identity, and terminal outcome without native receipt or journal paths.
				</p>
			</div>
			<div className="fleet-journal__empty-actions">
				<button
					type="button"
					className="button button--primary"
					onClick={onRefresh}
					disabled={pending}
				>
					{pending ? "Reading durable runs…" : "Inspect recent runs"}
				</button>
				<button type="button" className="button button--quiet" onClick={onBack}>
					Back to conversation
				</button>
			</div>
			<p className="fleet-journal__boundary">
				This record is installation-wide. A missing journal is reported as missing, never as an empty successful run.
			</p>
		</section>
	);
}

function fleetRunLabel(run: WireFleetInspectionRun): string {
	if (run.outcome !== null) return run.outcome;
	return run.terminal ? "terminal" : run.phase;
}

/**
 * Outcome text on a step comes from the ledger, so it is open rather than an
 * enum. Only the two words the scheduler writes for a settled step are given a
 * verdict tone; everything else stays neutral rather than guessing a colour for
 * a state this build has not seen.
 */
function fleetStepTone(step: WireFleetInspectionStep): string {
	if (step.runId === null) return "neutral";
	if (step.outcome === "succeeded") return "success";
	if (step.outcome === "failed") return "error";
	return "action";
}

export const FleetJournal = memo(function FleetJournal({
	inspection,
	pending,
	onRefresh,
	onBack,
}: {
	inspection: WireFleetInspection | null;
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const firstRunId = inspection?.runs[0]?.runId ?? null;
	const selected = inspection?.runs.find((run) => run.runId === selectedRunId) ?? inspection?.runs[0] ?? null;
	useEffect(() => {
		if (inspection === null || inspection.runs.length === 0) {
			setSelectedRunId(null);
		} else if (!inspection.runs.some((run) => run.runId === selectedRunId)) {
			setSelectedRunId(firstRunId);
		}
	}, [firstRunId, inspection, selectedRunId]);

	if (inspection === null) {
		return (
			<FleetRunsEmptyState
				pending={pending}
				onRefresh={onRefresh}
				onBack={onBack}
			/>
		);
	}
	const active = inspection.runs.filter((run) => !run.terminal).length;
	const verified = inspection.runs.filter((run) => run.evidence.state === "verified").length;
	const withJournals = inspection.runs.filter((run) => run.journal === "available").length;
	return (
		<section
			className="fleet-journal"
			aria-labelledby="fleet-journal-title"
			aria-busy={pending}
		>
			<header className="fleet-journal__masthead">
				<div>
					<div className="eyebrow">
						CLIO CODER DURABLE RUNS · INSTALLATION-WIDE · READ ONLY
					</div>
					<h2 id="fleet-journal-title">Recent run journal</h2>
					<p>
						Clio Coder read its run ledger at{" "}
						{formatTimestamp(inspection.generatedAt)}. Select a run to inspect its bounded durable event spine and
						authenticated receipt status.
					</p>
				</div>
				<div className="fleet-journal__masthead-actions">
					<span>
						{pending
							? "Following durable changes…"
							: active > 0
							? "Following while active runs remain"
							: `Inspected ${formatTimestamp(inspection.inspectedAt)}`}
					</span>
					<div>
						<button
							type="button"
							className="button button--quiet"
							onClick={onBack}
						>
							Back to conversation
						</button>
						<button
							type="button"
							className="button button--primary"
							onClick={onRefresh}
							disabled={pending}
						>
							Refresh record
						</button>
					</div>
				</div>
			</header>

			<dl
				className="fleet-journal__summary"
				aria-label="Recent durable run summary"
			>
				<div>
					<dt>Recent runs</dt>
					<dd>{inspection.runs.length.toLocaleString()}</dd>
					<dd>
						{inspection.truncated ? "Newest bounded window" : "Complete ledger window"}
					</dd>
				</div>
				<div className={active > 0 ? "is-active" : ""}>
					<dt>Active</dt>
					<dd>{active.toLocaleString()}</dd>
					<dd>
						{active > 0 ? "Automatic durable refresh on" : "No active row reported"}
					</dd>
				</div>
				<div>
					<dt>Journals available</dt>
					<dd>{withJournals.toLocaleString()}</dd>
					<dd>Missing stays distinct from empty</dd>
				</div>
				<div>
					<dt>Receipts verified</dt>
					<dd>{verified.toLocaleString()}</dd>
					<dd>Clio Coder trust projection</dd>
				</div>
			</dl>

			<section className="fleet-roots" aria-labelledby="fleet-roots-title">
				<div className="fleet-roots__heading">
					<div>
						<div className="eyebrow">FLEET ROOTS · PLANNED STEP INDEX</div>
						<h3 id="fleet-roots-title">Fleets that dispatched these runs</h3>
					</div>
					<p>
						A fleet root owns no journal or receipt of its own. This is the step order the fleet was written in and the
						run each step terminated on. Select a step to open that run's durable spine.
					</p>
				</div>
				{inspection.roots.length === 0
					? (
						<p className="fleet-roots__empty">
							Clio Coder reports no durable fleet roots. The runs above were dispatched individually, or their fleet
							records are older than this bounded window.
						</p>
					)
					: (
						<ul className="fleet-roots__list">
							{inspection.roots.map((root) => (
								<li key={root.rootId}>
									<header>
										<div>
											<strong>{root.fleet}</strong>
											<code>{root.rootId}</code>
										</div>
										<StatusMark
											tone={root.running ? "action" : "success"}
											label={root.running ? "In flight" : "Settled"}
										/>
									</header>
									<dl>
										<div>
											<dt>Started</dt>
											<dd>
												<time dateTime={root.startedAt}>
													{formatTimestamp(root.startedAt)}
												</time>
											</dd>
										</div>
										<div>
											<dt>Elapsed</dt>
											<dd>{formatDuration(Math.floor(root.elapsedMs / 1_000))}</dd>
										</div>
										<div>
											<dt>Steps recorded</dt>
											<dd>
												{root.recordedSteps.toLocaleString()} of {root.plannedSteps.toLocaleString()}
											</dd>
										</div>
										<div>
											<dt>Resumed from</dt>
											<dd>{root.resumedFrom ?? "not a resume"}</dd>
										</div>
									</dl>
									<ol
										className="fleet-step-index"
										aria-label={`Planned steps for fleet ${root.fleet}`}
									>
										{root.steps.map((step) => {
											const inWindow = step.runId !== null &&
												inspection.runs.some((run) => run.runId === step.runId);
											return (
												<li key={step.stepId}>
													<button
														type="button"
														disabled={!inWindow}
														aria-current={inWindow && selected?.runId === step.runId ? "true" : undefined}
														onClick={() => {
															if (step.runId !== null) setSelectedRunId(step.runId);
														}}
													>
														<span className="fleet-step-index__id">{step.stepId}</span>
														<StatusMark tone={fleetStepTone(step)} label={step.outcome} />
														<span className="fleet-step-index__run">
															{step.runId === null
																? "no run recorded"
																: `${step.agentId ?? "unattributed"} · ${
																	inWindow ? step.runId : "outside this run window"
																}`}
														</span>
													</button>
													{step.detail !== null && <p>{step.detail}</p>}
												</li>
											);
										})}
									</ol>
									{root.stepsTruncated && (
										<p className="fleet-roots__bound">
											Later planned steps are outside this bounded index.
										</p>
									)}
								</li>
							))}
						</ul>
					)}
				{inspection.rootsTruncated && (
					<p className="fleet-roots__bound">
						Older fleet roots are outside this bounded window.
					</p>
				)}
			</section>

			{inspection.runs.length === 0
				? (
					<section
						className="fleet-journal__no-runs"
						aria-label="No durable runs"
					>
						<div className="eyebrow">NO DURABLE RUNS REPORTED</div>
						<h3>The installation ledger has no recent run rows</h3>
						<p>
							This is an empty Clio Coder record, not a health claim and not a project-scoped result.
						</p>
					</section>
				)
				: (
					<div className="fleet-journal__grid">
						<ol className="fleet-run-list" aria-label="Recent Clio Coder runs">
							{inspection.runs.map((run) => (
								<li key={run.runId}>
									<button
										type="button"
										aria-current={selected?.runId === run.runId ? "true" : undefined}
										onClick={() => setSelectedRunId(run.runId)}
									>
										<span className="fleet-run-list__topline">
											<StatusMark
												tone={run.terminal ? (run.evidence.state === "failed" ? "error" : "success") : "action"}
												label={fleetRunLabel(run)}
											/>
											<time dateTime={run.startedAt}>
												{formatTimestamp(run.startedAt)}
											</time>
										</span>
										<strong>{run.task ?? "Task text unavailable"}</strong>
										<span className="fleet-run-list__route">
											{run.agentId} · {run.target} / {run.model}
										</span>
										<code>{run.runId}</code>
									</button>
								</li>
							))}
						</ol>

						{selected !== null && (
							<article
								className="fleet-run-record"
								aria-labelledby="fleet-run-record-title"
							>
								<header>
									<div>
										<div className="eyebrow">DURABLE EVENT SPINE</div>
										<h3 id="fleet-run-record-title">
											{selected.agentId} · {selected.runId}
										</h3>
									</div>
									<StatusMark
										tone={selected.terminal ? "success" : "action"}
										label={selected.terminal ? "Settled" : "Active"}
									/>
								</header>
								<dl className="fleet-run-record__facts">
									<div>
										<dt>Target</dt>
										<dd>{selected.target}</dd>
									</div>
									<div>
										<dt>Model</dt>
										<dd>{selected.model}</dd>
									</div>
									<div>
										<dt>Node</dt>
										<dd>{selected.node}</dd>
									</div>
									<div>
										<dt>Elapsed</dt>
										<dd>
											{formatDuration(Math.floor(selected.elapsedMs / 1_000))}
										</dd>
									</div>
								</dl>
								<section
									className={`fleet-run-evidence fleet-run-evidence--${selected.evidence.state}`}
								>
									<StatusMark
										tone={FLEET_EVIDENCE_PRESENTATION[selected.evidence.state]
											.tone}
										label={FLEET_EVIDENCE_PRESENTATION[selected.evidence.state]
											.label}
									/>
									<p>{selected.evidence.summary}</p>
								</section>
								{selected.journal === "missing"
									? (
										<p className="fleet-run-record__missing">
											Clio Coder reports no event journal for this run. Journal recording may have been off when it ran.
										</p>
									)
									: selected.events.length === 0
									? (
										<p className="fleet-run-record__missing">
											The journal exists but has no recorded events yet.
										</p>
									)
									: (
										<ol
											className="fleet-event-spine"
											aria-label={`Durable events for run ${selected.runId}`}
										>
											{selected.events.map((event, index) => (
												<li key={`${event.at}:${index}`}>
													<time dateTime={event.at}>
														{formatTimestamp(event.at)}
													</time>
													<strong>{event.label}</strong>
													{event.detail !== null && <p>{event.detail}</p>}
												</li>
											))}
										</ol>
									)}
								{selected.eventsTruncated && (
									<p className="fleet-run-record__truncated">
										Earlier journal events are outside this bounded view.
									</p>
								)}
								<footer>
									<strong>Outcome</strong>
									<p>
										{selected.outcome ?? (selected.terminal ? "Terminal outcome unavailable" : "Run remains active")}
										{selected.outcomeDetail === null ? "" : ` · ${selected.outcomeDetail}`}
									</p>
								</footer>
							</article>
						)}
					</div>
				)}

			<footer className="fleet-journal__method">
				<strong>Projection boundary</strong>
				<p>
					Every refresh runs the same fixed `fleet inspect --json` command. The browser never supplies a run id, path,
					filter, or arbitrary command argument; Clio Coder selects and sanitizes the bounded window before the host
					validates it again.
				</p>
			</footer>
		</section>
	);
});

function DispatchEmptyState({ pending, onRefresh, onBack }: {
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	return (
		<section
			className="dispatch-ledger dispatch-ledger--empty"
			aria-labelledby="dispatch-ledger-title"
			aria-busy={pending}
		>
			<div className="dispatch-ledger__empty-dial" aria-hidden="true">
				<span>Σ</span>
				<small>FLEET</small>
			</div>
			<div>
				<div className="eyebrow">DURABLE DISPATCH · READ ONLY</div>
				<h2 id="dispatch-ledger-title">
					Read Clio Coder's installation-wide dispatch ledger
				</h2>
				<p>
					This snapshot asks Clio Coder for admission state, aggregate running-work heartbeats, and cumulative tokens,
					cost, and runtime. It carries no run, agent, node, process, path, lineage, or budget identifiers.
				</p>
			</div>
			<div className="dispatch-ledger__empty-actions">
				<button
					type="button"
					className="button button--primary"
					onClick={onRefresh}
					disabled={pending}
				>
					{pending ? "Reading dispatch ledger…" : "Inspect dispatch status"}
				</button>
				<button type="button" className="button button--quiet" onClick={onBack}>
					Back to conversation
				</button>
			</div>
			<p className="dispatch-ledger__boundary">
				This is global installation state, not a fact about the selected project and not a live event stream.
			</p>
		</section>
	);
}

export const DispatchLedger = memo(function DispatchLedger({
	inspection,
	pending,
	onRefresh,
	onBack,
}: {
	inspection: WireDispatchInspection | null;
	pending: boolean;
	onRefresh(): void;
	onBack(): void;
}) {
	if (inspection === null) {
		return (
			<DispatchEmptyState
				pending={pending}
				onRefresh={onRefresh}
				onBack={onBack}
			/>
		);
	}
	const running = inspection.running;
	const admissionOpen = inspection.admission.state === "open";
	return (
		<section
			className="dispatch-ledger"
			aria-labelledby="dispatch-ledger-title"
			aria-busy={pending}
		>
			<header className="dispatch-ledger__masthead">
				<div>
					<div className="eyebrow">
						CLIO CODER FLEET STATUS · INSTALLATION-WIDE · READ ONLY
					</div>
					<h2 id="dispatch-ledger-title">
						Dispatch across this Clio Coder installation
					</h2>
					<p>
						Clio Coder read its durable ledger at{" "}
						{formatTimestamp(inspection.generatedAt)}. Figures below are reported by Clio Coder and deliberately are not
						attached to the selected project.
					</p>
				</div>
				<div className="dispatch-ledger__masthead-actions">
					<span>
						{pending ? "Refreshing snapshot…" : `Inspected ${formatTimestamp(inspection.inspectedAt)}`}
					</span>
					<div>
						<button
							type="button"
							className="button button--quiet"
							onClick={onBack}
						>
							Back to conversation
						</button>
						<button
							type="button"
							className="button button--primary"
							onClick={onRefresh}
							disabled={pending}
						>
							Refresh snapshot
						</button>
					</div>
				</div>
			</header>

			<dl
				className="dispatch-ledger__summary"
				aria-label="Installation-wide dispatch summary"
			>
				<div className={admissionOpen ? "is-open" : "is-draining"}>
					<dt>Admission</dt>
					<dd>{admissionOpen ? "Open" : "Draining"}</dd>
					<dd className="dispatch-ledger__summary-note">
						{admissionOpen
							? "New dispatch may be admitted"
							: `Until ${formatTimestamp(inspection.admission.expiresAt!)}`}
					</dd>
				</div>
				<div>
					<dt>Running rows</dt>
					<dd>{running.total.toLocaleString()}</dd>
					<dd className="dispatch-ledger__summary-note">
						Durable snapshot, not a live board
					</dd>
				</div>
				<div>
					<dt>Total tokens</dt>
					<dd>{formatTokenCount(inspection.totals.totalTokens)}</dd>
					<dd className="dispatch-ledger__summary-note">
						Across the installation ledger
					</dd>
				</div>
				<div>
					<dt>Clio Coder-reported cost</dt>
					<dd>{formatUsageCost(inspection.totals.costUsd)}</dd>
					<dd className="dispatch-ledger__summary-note">
						Never a GUI estimate
					</dd>
				</div>
			</dl>

			<div className="dispatch-ledger__grid">
				<section
					className="dispatch-record"
					aria-labelledby="dispatch-running-title"
				>
					<header>
						<div>
							<div className="eyebrow">CURRENT EXECUTION</div>
							<h3 id="dispatch-running-title">Heartbeat classification</h3>
						</div>
						<strong>{running.total.toLocaleString()} ROWS</strong>
					</header>
					<dl className="dispatch-heartbeats">
						<div className="is-alive">
							<dt>Alive</dt>
							<dd>{running.alive.toLocaleString()}</dd>
						</div>
						<div className="is-stale">
							<dt>Stale</dt>
							<dd>{running.stale.toLocaleString()}</dd>
						</div>
						<div className="is-dead">
							<dt>Dead</dt>
							<dd>{running.dead.toLocaleString()}</dd>
						</div>
						<div>
							<dt>Not reported</dt>
							<dd>{running.unreported.toLocaleString()}</dd>
						</div>
					</dl>
					<p>
						These counts preserve Clio Coder's own process and heartbeat classification while removing every row
						identity.
					</p>
				</section>

				<section
					className="dispatch-record"
					aria-labelledby="dispatch-totals-title"
				>
					<header>
						<div>
							<div className="eyebrow">DURABLE TOTALS</div>
							<h3 id="dispatch-totals-title">
								Cumulative work recorded by Clio Coder
							</h3>
						</div>
						<strong>ALL LEDGER ROWS</strong>
					</header>
					<dl className="dispatch-totals">
						<div>
							<dt>Input tokens</dt>
							<dd>{formatTokenCount(inspection.totals.inputTokens)}</dd>
						</div>
						<div>
							<dt>Output tokens</dt>
							<dd>{formatTokenCount(inspection.totals.outputTokens)}</dd>
						</div>
						<div>
							<dt>Runtime</dt>
							<dd>
								{formatDuration(Math.round(inspection.totals.runtimeSeconds))}
							</dd>
						</div>
						<div>
							<dt>Retry queue reported</dt>
							<dd>{inspection.retryingCount.toLocaleString()}</dd>
						</div>
					</dl>
					<p>
						Token totals are preserved exactly as separate Clio Coder fields; the GUI does not assume they are additive.
					</p>
				</section>
			</div>

			<footer className="dispatch-ledger__method">
				<strong>Snapshot boundary</strong>
				<p>
					The command is provider-free and read-only, but it has no project selector. Live enqueue, progress,
					completion, node-capacity, gate, council, and retry transitions still require sanitized Clio Coder events. The
					cross-process status command cannot observe another orchestrator's in-memory retry queue, and no drain or
					resume control is exposed here.
				</p>
			</footer>
		</section>
	);
});

interface PromptEditorHandle {
	useExample(prompt: string): void;
}

interface PromptEditorProps {
	projectId: string | null;
	activeTurnId: string | null;
	occupied: boolean;
	pendingTurnStart: boolean;
	actions: WorkbenchActions;
	/** Called after a prompt is sent, so the transcript can follow the new turn. */
	onSend?: () => void;
}

/**
 * The editor owns its text so stream-frame state changes do not reconcile the
 * textarea the operator is actively typing or scrolling. Its scalar props are
 * stable for the lifetime of a turn, while the live status above it can update
 * independently at the display cadence.
 */
const PromptEditor = memo(
	forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(
		{ projectId, activeTurnId, occupied, pendingTurnStart, actions, onSend },
		ref,
	) {
		const [prompt, setPrompt] = useState("");
		const textarea = useRef<HTMLTextAreaElement>(null);
		const canSubmit = projectId !== null && !occupied && !pendingTurnStart &&
			prompt.trim().length > 0;

		useImperativeHandle(ref, () => ({
			useExample(example: string): void {
				setPrompt(example);
				requestAnimationFrame(() => textarea.current?.focus());
			},
		}), []);

		function submit(event: FormEvent): void {
			event.preventDefault();
			const value = prompt.trim();
			if (!canSubmit || projectId === null) return;
			actions.startTurn(projectId, value);
			setPrompt("");
			onSend?.();
		}

		function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
			if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
			event.preventDefault();
			event.currentTarget.form?.requestSubmit();
		}

		return (
			<form className="composer__entry" onSubmit={submit}>
				<div className="composer__input-row">
					<textarea
						ref={textarea}
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={projectId === null ? "Open a project first" : "Ask Clio Coder to do something in this project"}
						aria-label="Prompt for Clio Coder"
						rows={3}
						disabled={projectId === null}
					/>
					{activeTurnId !== null
						? (
							<button
								type="button"
								className="composer__submit composer__submit--cancel"
								onClick={() =>
									projectId !== null &&
									actions.cancelTurn(projectId, activeTurnId)}
							>
								Stop
							</button>
						)
						: (
							<button
								type="submit"
								className="composer__submit"
								disabled={!canSubmit}
							>
								Send
							</button>
						)}
				</div>
				<div className="composer__footer">
					{occupied && activeTurnId === null && (
						<span className="composer__notice">
							Clio Coder is finishing the previous prompt.
						</span>
					)}
					<span className="composer__shortcut">Ctrl or Cmd + Enter sends</span>
					<span className="composer__privacy">
						Prompts go only to the Clio Coder target you configured.
					</span>
				</div>
			</form>
		);
	}),
);

function ConversationCanvas({
	state,
	dispatch,
	actions,
	obscured,
	nowMs,
	projectRailIsDrawer,
	projectRailCollapsed,
	onProjectRailToggle,
	inspectorIsDrawer,
	inspectorCollapsed,
	inspectorOpen,
	onInspectorToggle,
	workspaceView,
	onWorkspaceViewChange,
	onConversationOpen,
	onRefreshConfig,
	onRefreshCatalog,
	onRefreshUsage,
	onRefreshDispatch,
	onRefreshFleet,
}: {
	state: AppState;
	dispatch: Dispatch<AppAction>;
	actions: WorkbenchActions;
	obscured: boolean;
	nowMs: number;
	projectRailIsDrawer: boolean;
	projectRailCollapsed: boolean;
	onProjectRailToggle(): void;
	inspectorIsDrawer: boolean;
	inspectorCollapsed: boolean;
	inspectorOpen: boolean;
	onInspectorToggle(): void;
	workspaceView: WorkspaceView;
	onWorkspaceViewChange(view: WorkspaceView): void;
	onConversationOpen(): void;
	onRefreshConfig(): void;
	onRefreshCatalog(): void;
	onRefreshUsage(): void;
	onRefreshDispatch(): void;
	onRefreshFleet(): void;
}) {
	const open = state.open;
	const promptEditor = useRef<PromptEditorHandle>(null);
	const projection = open?.projection ?? null;
	const activeTurn = projection?.activeTurn ?? null;
	const pendingPermission = projection?.pendingPermission ?? null;
	const activeTurnStartedMs = activeTurn === null ? Number.NaN : Date.parse(activeTurn.startedAt);
	const elapsed = Number.isFinite(activeTurnStartedMs)
		? Math.max(0, Math.floor((nowMs - activeTurnStartedMs) / 1_000))
		: 0;
	const busy = isPromptBlocked(open);
	const clioOccupied = open !== null && busy;
	const projectControlVisible = projectRailIsDrawer || projectRailCollapsed;
	const evidenceControlVisible = inspectorIsDrawer || inspectorCollapsed;
	const permissionWait = pendingPermission === null ? 0 : Math.max(
		0,
		Math.floor((nowMs - Date.parse(pendingPermission.requestedAt)) / 1_000),
	);
	const permissionEscalated = pendingPermission !== null &&
		nowMs >= Date.parse(pendingPermission.escalateAt);
	const projectId = open?.project.id ?? null;
	const activeTurnId = activeTurn?.turnId ?? null;
	const permissionId = pendingPermission?.permissionId ?? null;
	const timeline = projection?.timeline ?? null;
	// Settled turns keep their identity across frames, so only the streaming turn re-renders.
	const previousTurns = useRef(groupTurns([]));
	const turns = useMemo(() => {
		const next = groupTurns(timeline ?? [], previousTurns.current);
		previousTurns.current = next;
		return next;
	}, [timeline]);
	const transcriptView = workspaceView === "conversation" ||
		workspaceView === "timeline";
	// The conversation anchors the approval on its activity row; when the host
	// has no such row yet, the standalone card still offers the decision.
	const approvalAnchored = pendingPermission !== null &&
		(timeline ?? []).some((item) =>
			item.kind === "approval" && item.status === "waiting" &&
			item.id.endsWith(`:${pendingPermission.permissionId}`)
		);
	const scrollRegion = useRef<HTMLDivElement>(null);
	const scrollMemory = useRef(new Map<WorkspaceView, ScrollPosition>());
	const follow = useFollowLatest(scrollRegion, transcriptView, timeline);
	const { jumpToLatest, snapshot: snapshotScroll, restore: restoreScroll } = follow;

	// Each view remembers where the operator left it, including whether it was
	// following the latest output. Restoring through the hook keeps the scroll
	// event caused by swapping content from reading as the operator's, so a
	// Timeline left scrolled up stays there even after a short Conversation
	// clamped the region back to the top in between.
	useLayoutEffect(() => {
		const element = scrollRegion.current;
		if (element === null) return;
		const remembered = scrollMemory.current.get(workspaceView);
		if (transcriptView) {
			restoreScroll(remembered ?? { top: 0, following: true });
		} else element.scrollTop = remembered?.top ?? 0;
	}, [workspaceView, transcriptView, restoreScroll]);

	const changeView = useCallback((view: WorkspaceView): void => {
		scrollMemory.current.set(workspaceView, snapshotScroll());
		onWorkspaceViewChange(view);
	}, [onWorkspaceViewChange, workspaceView, snapshotScroll]);

	const resolvePending = useCallback(
		(decision: "allow-once" | "reject"): void => {
			if (
				projectId === null || permissionId === null || activeTurnId === null
			) return;
			actions.resolvePermission(
				projectId,
				activeTurnId,
				permissionId,
				decision,
			);
		},
		[actions, projectId, activeTurnId, permissionId],
	);

	const onSend = useCallback((): void => {
		jumpToLatest();
	}, [jumpToLatest]);

	function startFromExample(example: string): void {
		promptEditor.current?.useExample(example);
	}

	const emptyTranscript = turns.length === 0
		? (
			<div className="timeline-empty">
				<div className="timeline-empty__reticle" aria-hidden="true">◎</div>
				<div>
					<div className="eyebrow">NEW RESEARCH THREAD</div>
					<h2>What would you like to understand or change?</h2>
					<p>
						Start in your own words, or use one of these as a starting point.
					</p>
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
		: null;

	return (
		<main
			className="conversation"
			id="conversation"
			aria-hidden={obscured ? true : undefined}
			inert={obscured}
		>
			<header
				className={`conversation__header${projectControlVisible ? " has-project-control" : ""}${
					evidenceControlVisible ? " has-evidence-control" : ""
				}`}
			>
				<div
					className={`mobile-controls rail-control--project${projectControlVisible ? " is-visible" : ""}`}
				>
					<button
						type="button"
						className="icon-button"
						aria-controls="project-rail"
						aria-expanded={projectRailIsDrawer ? state.leftDrawerOpen : !projectRailCollapsed}
						onClick={onProjectRailToggle}
					>
						<Glyph>{projectRailIsDrawer ? "≡" : "›"}</Glyph>
						<span className="sr-only">
							{projectRailIsDrawer ? "Open projects and files" : "Show projects, files, and sessions"}
						</span>
					</button>
				</div>
				<div className="conversation__identity">
					<div className="eyebrow">
						{workspaceView === "dispatch"
							? "INSTALLATION-WIDE"
							: workspaceView === "fleet-runs"
							? "INSTALLATION-WIDE RUN RECORD"
							: workspaceView === "effective-clio-coder"
							? "EFFECTIVE CLIO CODER FOR"
							: workspaceView === "catalog"
							? "CAPABILITY ATLAS FOR"
							: workspaceView === "usage"
							? "USAGE RECORD FOR"
							: workspaceView === "timeline"
							? "SESSION TIMELINE FOR"
							: "ACTIVE PROJECT"}
					</div>
					<h1>
						{workspaceView === "dispatch"
							? "Clio Coder dispatch"
							: workspaceView === "fleet-runs"
							? "Clio Coder durable runs"
							: open === null
							? "No project open"
							: open.project.displayName}
					</h1>
					{workspaceView === "dispatch" || workspaceView === "fleet-runs"
						? (
							<p className="conversation__root">
								Durable fleet status across this Clio Coder installation
							</p>
						)
						: open && <p className="conversation__root">{open.project.rootPath}</p>}
				</div>
				<div className="conversation__telemetry">
					{open && (
						<StatusMark
							tone={PHASE_PRESENTATION[open.clio.phase].tone}
							label={PHASE_PRESENTATION[open.clio.phase].label}
						/>
					)}
					{open && (
						<nav
							className="conversation__view-switcher"
							aria-label="Clio Coder views"
						>
							{([
								"conversation",
								"timeline",
								"effective-clio-coder",
								"catalog",
								"usage",
								"dispatch",
								"fleet-runs",
							] as const).map((
								view,
							) => (
								<button
									type="button"
									key={view}
									className="button button--quiet"
									aria-current={workspaceView === view ? "page" : undefined}
									onClick={() => changeView(view)}
								>
									{view === "conversation"
										? "Conversation"
										: view === "timeline"
										? "Timeline"
										: view === "effective-clio-coder"
										? "Effective Clio Coder"
										: view === "catalog"
										? "Catalog"
										: view === "usage"
										? "Usage"
										: view === "dispatch"
										? "Dispatch"
										: "Runs"}
								</button>
							))}
						</nav>
					)}
					<button
						type="button"
						className="button button--quiet"
						onClick={() => dispatch({ type: "settings.opened", open: true })}
					>
						Settings
					</button>
				</div>
				<div
					className={`mobile-controls mobile-controls--evidence rail-control--evidence${
						evidenceControlVisible ? " is-visible" : ""
					}`}
				>
					<button
						type="button"
						className="icon-button"
						aria-controls="evidence-rail"
						aria-expanded={inspectorIsDrawer ? inspectorOpen : !inspectorCollapsed}
						onClick={onInspectorToggle}
					>
						<Glyph>{inspectorIsDrawer ? "◫" : "‹"}</Glyph>
						<span className="sr-only">
							{inspectorIsDrawer ? "Open run and evidence overview" : "Show run and evidence overview"}
						</span>
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
			<div
				className="conversation__scroll"
				ref={scrollRegion}
				tabIndex={0}
				role="region"
				aria-label={workspaceView === "effective-clio-coder"
					? "Effective Clio Coder map"
					: workspaceView === "catalog"
					? "Clio Coder capability catalog"
					: workspaceView === "usage"
					? "Thirty-day project usage record"
					: workspaceView === "dispatch"
					? "Installation-wide dispatch snapshot"
					: workspaceView === "fleet-runs"
					? "Installation-wide durable run journal"
					: workspaceView === "timeline"
					? "Session timeline"
					: "Conversation history"}
			>
				{open !== null && workspaceView === "conversation"
					? (
						<div className="conversation__content">
							{open.clio.lastFailure && (
								<section className="conversation__failure" role="status">
									<div className="eyebrow">CLIO CODER REPORTED A FAILURE</div>
									<p>{open.clio.lastFailure.summary}</p>
									<code>{open.clio.lastFailure.code}</code>
								</section>
							)}
							{
								/* Reported dispatch runs only. An empty strip means Clio Coder reported no runs, which is not
							    the same claim as "no runs exist"; the strip is silent rather than reassuring. */
							}
							<FleetStrip runs={open.fleet} />
							<ChatTranscript
								turns={turns}
								phase={open.clio.phase}
								pendingPermission={activeTurn === null ? null : pendingPermission}
								nowMs={nowMs}
								onResolve={resolvePending}
								truncated={projection?.timelineTruncated === true ||
									open.clio.session?.replayTruncated === true}
							>
								{emptyTranscript}
								{pendingPermission !== null && activeTurn !== null &&
									!approvalAnchored && (
									<PermissionCard
										permission={pendingPermission}
										escalated={permissionEscalated}
										elapsed={permissionWait}
										onResolve={resolvePending}
									/>
								)}
							</ChatTranscript>
						</div>
					)
					: open !== null && workspaceView === "effective-clio-coder"
					? (
						<EffectiveClioMap
							inspection={open.configInspection}
							pending={state.pendingConfigInspect !== null}
							onRefresh={onRefreshConfig}
							onBack={onConversationOpen}
						/>
					)
					: open !== null && workspaceView === "catalog"
					? (
						<ClioCatalog
							inspection={open.catalogInspection}
							pending={state.pendingCatalogInspect !== null}
							onRefresh={onRefreshCatalog}
							onBack={onConversationOpen}
						/>
					)
					: open !== null && workspaceView === "usage"
					? (
						<UsageNotebook
							inspection={open.usageInspection}
							pending={state.pendingUsageInspect !== null}
							onRefresh={onRefreshUsage}
							onBack={onConversationOpen}
						/>
					)
					: workspaceView === "dispatch"
					? (
						<DispatchLedger
							inspection={state.dispatchInspection}
							pending={state.pendingDispatchInspect !== null}
							onRefresh={onRefreshDispatch}
							onBack={onConversationOpen}
						/>
					)
					: workspaceView === "fleet-runs"
					? (
						<FleetJournal
							inspection={state.fleetInspection}
							pending={state.pendingFleetInspect !== null}
							onRefresh={onRefreshFleet}
							onBack={onConversationOpen}
						/>
					)
					: open === null
					? (
						<FirstRunGuide
							state={state}
							onBrowse={() => actions.browseProjects()}
						/>
					)
					: (
						<div className="conversation__content">
							{open.clio.lastFailure && (
								<section className="conversation__failure" role="status">
									<div className="eyebrow">CLIO CODER REPORTED A FAILURE</div>
									<p>{open.clio.lastFailure.summary}</p>
									<code>{open.clio.lastFailure.code}</code>
								</section>
							)}
							{(projection?.timelineTruncated === true ||
								open.clio.session?.replayTruncated === true) && (
								<p className="timeline-note">
									Earlier turns are not shown; Clio Coder still has the full context.
								</p>
							)}
							<section
								className="evidence-timeline"
								aria-label="Request, work, approval, and outcome timeline"
							>
								{emptyTranscript ??
									(projection?.timeline ?? []).map((item) => (
										<TimelineCard
											item={item}
											nowMs={item.status === "active" ? nowMs : 0}
											key={item.id}
										/>
									))}
							</section>
							{pendingPermission !== null && activeTurn !== null && (
								<PermissionCard
									permission={pendingPermission}
									escalated={permissionEscalated}
									elapsed={permissionWait}
									onResolve={resolvePending}
								/>
							)}
						</div>
					)}
			</div>
			{transcriptView && open !== null && (
				<div className="jump-anchor">
					<JumpToLatest follow={follow} />
				</div>
			)}

			<div
				className={`composer${activeTurn !== null ? " composer--active" : ""}`}
			>
				<div className="composer__mode">
					<span className="composer__mode-label">
						{open === null ? "START" : clioOccupied ? "RUNNING" : "MESSAGE"}
					</span>
					<span className="composer__status" role="status" aria-live="polite">
						{activeTurn
							? `${formatDuration(elapsed)} · ${activeTurn.toolCalls} tool ${
								activeTurn.toolCalls === 1 ? "call" : "calls"
							}${activeTurn.lastToolTitle === null ? "" : ` · ${activeTurn.lastToolTitle}`}${
								activeTurn.repeatedShapes > 0 ? ` · ${activeTurn.repeatedShapes} repeated` : ""
							}`
							: open === null
							? "Open a project folder to talk to Clio Coder."
							: "Ready for your next prompt."}
					</span>
				</div>
				<PromptEditor
					ref={promptEditor}
					projectId={open?.project.id ?? null}
					activeTurnId={activeTurn?.turnId ?? null}
					occupied={clioOccupied}
					pendingTurnStart={state.pendingTurnStart !== null}
					actions={actions}
					onSend={onSend}
				/>
			</div>
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
		<Modal
			title="Choose a project folder"
			eyebrow="DIRECTORIES ONLY"
			onClose={onClose}
		>
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
								onClick={() =>
									actions.browseProjects(
										`${listing.path.replace(/\/$/u, "")}/${entry.name}`,
									)}
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
				<small>
					{target.isOrchestrator ? `${target.runtime} · orchestrator` : target.runtime}
				</small>
				<small className="target-row__models">
					{target.models.length === 0 ? "no models reported" : target.models.join(", ")}
				</small>
			</div>
			<div className="target-row__health">
				{health === null ? <small className="target-row__unprobed">not probed</small> : (
					<>
						<StatusMark
							tone={health.healthy ? "success" : "error"}
							label={health.healthy ? "healthy" : "unhealthy"}
						/>
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
	const [granted, setGranted] = useState<
		NotificationPermission | "unsupported"
	>(() => typeof Notification === "undefined" ? "unsupported" : Notification.permission);
	return (
		<section
			className="settings__notifications"
			aria-labelledby="settings-notifications-title"
		>
			<h3 id="settings-notifications-title" className="settings__heading">
				Approvals
			</h3>
			{granted === "unsupported" && (
				<p className="settings__note">
					This browser cannot post desktop notifications.
				</p>
			)}
			{granted === "denied" && (
				<p className="settings__note">
					Your browser is blocking notifications for this page.
				</p>
			)}
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
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event) => onChange(event.target.checked)}
					/>
					Desktop notifications for approvals
				</label>
			)}
			<p className="settings__note">
				A notification carries the tool title only. The GUI never puts a project path in one.
			</p>
		</section>
	);
}

function routingCapabilityLabel(
	value: WireRoutingModel["capabilities"][number],
): string {
	if (value === "fim") return "FIM";
	return catalogLabel(value);
}

function RoutingModelCard({ model }: { model: WireRoutingModel }) {
	return (
		<li className="routing-model-card">
			<header>
				<div>
					<code title={model.modelId}>{model.modelId}</code>
					<small>{model.runtimeId}</small>
				</div>
				<span className={`routing-signal routing-signal--${model.residency}`}>
					{model.residency === "not-reported" ? "Not reported" : catalogLabel(model.residency)}
				</span>
			</header>
			<dl>
				<div>
					<dt>Context window</dt>
					<dd>
						{model.contextWindow === 0 ? "Not reported" : formatTokenCount(model.contextWindow)}
					</dd>
				</div>
				<div>
					<dt>Maximum output</dt>
					<dd>
						{model.maxOutputTokens === 0 ? "Not reported" : formatTokenCount(model.maxOutputTokens)}
					</dd>
				</div>
			</dl>
			<div
				className="routing-capabilities"
				aria-label="Reported model capabilities"
			>
				{model.capabilities.length === 0
					? (
						<span className="routing-capabilities__empty">
							No capabilities reported
						</span>
					)
					: model.capabilities.map((capability) => <span key={capability}>{routingCapabilityLabel(capability)}</span>)}
			</div>
		</li>
	);
}

export const RoutingInventory = memo(function RoutingInventory({
	projectId,
	inspection,
	pending,
	onRefresh,
}: {
	projectId: string;
	inspection: WireRoutingInspection | null;
	pending: boolean;
	onRefresh(projectId: string): void;
}) {
	const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(
		query.trim().toLocaleLowerCase("en-US"),
	);
	const targets = inspection === null ? [] : [...new Set(inspection.models.items.map((model) => model.targetId))].sort(
		(left, right) => left.localeCompare(right, "en-US"),
	);
	const activeTarget = selectedTarget !== null && targets.includes(selectedTarget)
		? selectedTarget
		: targets[0] ?? null;
	const visibleModels = inspection === null || activeTarget === null
		? []
		: inspection.models.items.filter((model) =>
			model.targetId === activeTarget && (
				deferredQuery.length === 0 ||
				[model.modelId, model.runtimeId, model.residency, ...model.capabilities]
					.some((value) => value.toLocaleLowerCase("en-US").includes(deferredQuery))
			)
		);
	const refresh = useCallback(() => onRefresh(projectId), [
		onRefresh,
		projectId,
	]);

	return (
		<section
			className="settings__routing"
			aria-labelledby="settings-routing-title"
			aria-busy={pending}
		>
			<div className="settings__section-heading settings__routing-heading">
				<div>
					<div className="eyebrow">MODELS · WORKER ROUTING</div>
					<h3 id="settings-routing-title">What Clio Coder can route work to</h3>
				</div>
				<p>
					Offline model facts and effective worker profiles from Clio Coder—no endpoint probe, package mutation, or
					local configuration rewrite.
				</p>
			</div>

			{inspection === null
				? (
					<div className="routing-inventory__empty">
						<p>
							Read Clio Coder's cached/configured model catalog and agent-profile bindings for this project.
						</p>
						<button
							type="button"
							className="button button--quiet"
							onClick={refresh}
							disabled={pending}
						>
							{pending ? "Inspecting models and routes…" : "Inspect models and routes"}
						</button>
					</div>
				)
				: (
					<>
						<div className="routing-inventory__summary">
							<dl>
								<div>
									<dt>Targets with models</dt>
									<dd>{targets.length}</dd>
								</div>
								<div>
									<dt>Offline model rows</dt>
									<dd>{inspection.models.items.length}</dd>
								</div>
								<div>
									<dt>Worker profiles</dt>
									<dd>{inspection.profiles.items.length}</dd>
								</div>
								<div>
									<dt>Agent bindings</dt>
									<dd>{inspection.bindings.items.length}</dd>
								</div>
							</dl>
							<button
								type="button"
								className="button button--quiet"
								onClick={refresh}
								disabled={pending}
							>
								{pending ? "Refreshing…" : "Refresh inventory"}
							</button>
						</div>

						<section
							className="routing-models"
							aria-labelledby="routing-models-title"
						>
							<div className="routing-subhead">
								<div>
									<h4 id="routing-models-title">Offline model capabilities</h4>
									<p>
										Limits and residency are Clio Coder's cached or configured facts; they are not a health claim.
									</p>
								</div>
								{inspection.models.emptyTargetCount > 0 && (
									<small>
										{inspection.models.emptyTargetCount} target reported no model candidates
									</small>
								)}
							</div>
							{inspection.models.availability === "failed"
								? (
									<p className="routing-collection-state is-failed">
										Clio Coder's offline model listing could not be read.
									</p>
								)
								: targets.length === 0
								? (
									<p className="routing-collection-state">
										Clio Coder reported no offline model candidates.
									</p>
								)
								: (
									<>
										<div className="routing-models__controls">
											<div
												className="routing-target-tabs"
												role="group"
												aria-label="Model targets"
											>
												{targets.map((target) => (
													<button
														type="button"
														aria-pressed={activeTarget === target}
														onClick={() => {
															setSelectedTarget(target);
															setQuery("");
														}}
														key={target}
													>
														{target}
													</button>
												))}
											</div>
											<label className="routing-model-search">
												<span>Filter models</span>
												<input
													type="search"
													value={query}
													onChange={(event) => setQuery(event.target.value)}
													placeholder="Model id or capability"
												/>
											</label>
										</div>
										{visibleModels.length === 0
											? (
												<p className="routing-collection-state">
													No models match this filter.
												</p>
											)
											: (
												<ul className="routing-model-list">
													{visibleModels.map((model) => (
														<RoutingModelCard
															model={model}
															key={`${model.targetId}:${model.modelId}`}
														/>
													))}
												</ul>
											)}
									</>
								)}
							{inspection.models.truncated && (
								<p className="routing-bound-note">
									The offline model inventory reached the GUI row bound.
								</p>
							)}
						</section>

						<div className="routing-workforce">
							<section aria-labelledby="routing-profiles-title">
								<div className="routing-subhead">
									<div>
										<h4 id="routing-profiles-title">Worker profiles</h4>
										<p>Named routes available to delegated work.</p>
									</div>
								</div>
								{inspection.profiles.availability === "failed"
									? (
										<p className="routing-collection-state is-failed">
											Worker profiles could not be read.
										</p>
									)
									: inspection.profiles.items.length === 0
									? (
										<p className="routing-collection-state">
											No worker profiles are configured.
										</p>
									)
									: (
										<ul className="routing-profile-list">
											{inspection.profiles.items.map((profile) => (
												<li key={profile.name}>
													<header>
														<strong>{profile.name}</strong>
														<span>
															{catalogLabel(profile.thinkingLevel)} thinking
														</span>
													</header>
													<code>
														{profile.target ?? "Clio Coder default target"} · {profile.model ?? "default model"}
													</code>
													<small>
														{profile.runtime ?? "Runtime resolved when used"}
													</small>
												</li>
											))}
										</ul>
									)}
							</section>
							<section aria-labelledby="routing-bindings-title">
								<div className="routing-subhead">
									<div>
										<h4 id="routing-bindings-title">Agent bindings</h4>
										<p>Which recipes request a named worker profile.</p>
									</div>
								</div>
								{inspection.bindings.availability === "failed"
									? (
										<p className="routing-collection-state is-failed">
											Agent bindings could not be read.
										</p>
									)
									: inspection.bindings.items.length === 0
									? (
										<p className="routing-collection-state">
											No agents are bound to worker profiles.
										</p>
									)
									: (
										<ul className="routing-binding-list">
											{inspection.bindings.items.map((binding) => (
												<li
													className={binding.resolved ? "is-resolved" : "is-unresolved"}
													key={binding.agentId}
												>
													<div>
														<strong>{binding.agentId}</strong>
														<code>{binding.profile}</code>
													</div>
													<span>
														{binding.resolved ? "Resolved" : "Missing profile"}
													</span>
												</li>
											))}
										</ul>
									)}
							</section>
						</div>

						<p className="routing-boundary">
							Model and route identifiers already belong to Clio Coder's public routing surface. Provider URLs,
							credentials, environment, native paths, and raw warnings remain on the host.
						</p>
					</>
				)}
		</section>
	);
});

function toolchainResolution(item: WireToolchainItem): { label: string; tone: "success" | "warning" | "neutral" } {
	if (!item.supported) return { label: "Platform unsupported", tone: "neutral" };
	if (item.source === "path") return { label: "Using PATH", tone: "success" };
	if (item.source === "vendored") return { label: "Using pinned copy", tone: "success" };
	return { label: "Not available", tone: "warning" };
}

export const ToolchainInventory = memo(function ToolchainInventory({
	inspection,
	pending,
	onInspect,
}: {
	inspection: WireToolchainInspection | null;
	pending: boolean;
	onInspect(): void;
}) {
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase("en-US"));
	const visible = inspection?.tools.filter((item) =>
		deferredQuery.length === 0 || [
			item.id,
			item.pinnedVersion,
			item.license,
			item.platform ?? "unsupported",
			item.source,
			item.foundVersion ?? "missing",
		].some((value) => value.toLocaleLowerCase("en-US").includes(deferredQuery))
	) ?? [];
	const resolved = inspection?.tools.filter((item) => item.source !== "none").length ?? 0;
	const vendored = inspection?.tools.filter((item) => item.installed).length ?? 0;
	const unsupported = inspection?.tools.filter((item) => !item.supported).length ?? 0;

	return (
		<section
			className="settings__toolchain"
			aria-labelledby="settings-toolchain-title"
			aria-busy={pending}
		>
			<div className="settings__section-heading settings__toolchain-heading">
				<div>
					<div className="eyebrow">OPTIONAL PROGRAMS · INSTALLATION-WIDE</div>
					<h3 id="settings-toolchain-title">Clio Coder toolchain</h3>
				</div>
				<p>
					Pinned versions, license, platform support, and path-free resolution facts from Clio Coder. Inspection never
					downloads or installs a program.
				</p>
			</div>

			{inspection === null
				? (
					<div className="toolchain-empty">
						<p>
							Read the optional programs this Clio Coder build knows how to drive and whether this installation can
							resolve them.
						</p>
						<button type="button" className="button button--quiet" onClick={onInspect} disabled={pending}>
							{pending ? "Inspecting toolchain…" : "Inspect toolchain"}
						</button>
					</div>
				)
				: (
					<>
						<div className="toolchain-summary">
							<dl aria-label="Pinned toolchain summary">
								<div>
									<dt>Pinned tools</dt>
									<dd>{inspection.tools.length}</dd>
								</div>
								<div>
									<dt>Resolved</dt>
									<dd>{resolved}</dd>
								</div>
								<div>
									<dt>Vendored copies</dt>
									<dd>{vendored}</dd>
								</div>
								<div>
									<dt>Unsupported here</dt>
									<dd>{unsupported}</dd>
								</div>
							</dl>
							<div className="toolchain-summary__actions">
								<label>
									<span>Filter tools</span>
									<input
										type="search"
										value={query}
										onChange={(event) => setQuery(event.target.value)}
										placeholder="Name, license, platform, source"
									/>
								</label>
								<button type="button" className="button button--quiet" onClick={onInspect} disabled={pending}>
									{pending ? "Refreshing…" : "Refresh inventory"}
								</button>
							</div>
						</div>

						{visible.length === 0
							? <p className="toolchain-no-match">No pinned tools match this filter.</p>
							: (
								<ul className="toolchain-list">
									{visible.map((item) => {
										const resolution = toolchainResolution(item);
										return (
											<li key={item.id}>
												<header>
													<div>
														<strong>{item.id}</strong>
														<code>{item.license}</code>
													</div>
													<StatusMark tone={resolution.tone} label={resolution.label} />
												</header>
												<dl>
													<div>
														<dt>Pinned</dt>
														<dd>{item.pinnedVersion}</dd>
													</div>
													<div>
														<dt>PATH floor</dt>
														<dd>{item.minimumVersion}</dd>
													</div>
													<div>
														<dt>Found</dt>
														<dd>{item.foundVersion ?? "not resolved"}</dd>
													</div>
													<div>
														<dt>Platform</dt>
														<dd>{item.platform ?? "no pinned asset"}</dd>
													</div>
												</dl>
												<p className="toolchain-list__note">
													{item.source === "path"
														? "A compatible system copy wins over Clio Coder's pinned copy."
														: item.source === "vendored"
														? "Clio Coder resolves its checksum-verified pinned copy."
														: item.pathCandidate === null
														? "No compatible program was resolved."
														: `A PATH copy reports ${
															item.pathCandidate.version ?? "no readable version"
														} and does not clear the ${item.minimumVersion} floor.`}
												</p>
												<span className="toolchain-list__installed">
													{item.installed ? "Pinned copy installed" : "Pinned copy not installed"}
												</span>
											</li>
										);
									})}
								</ul>
							)}
						{inspection.truncated && <p className="toolchain-bound">The tool inventory reached the GUI row bound.</p>}
					</>
				)}
			<p className="toolchain-boundary">
				Native install paths, executable paths, rejected PATH locations, and raw resolution prose remain on the host.
				The fixed read invokes only <code>tools list --json</code>; installation remains an explicit terminal operation.
			</p>
		</section>
	);
});

const RECOVERY_SECTION_PRESENTATION: Record<
	WireRecoverySectionId,
	{ readonly label: string; readonly description: string }
> = {
	runtime: {
		label: "Runtime",
		description: "Clio Coder, Node, platform, and engine readiness.",
	},
	storage: {
		label: "Local layout",
		description: "The four resolved configuration, data, state, and cache roots.",
	},
	configuration: {
		label: "Configuration",
		description: "Settings validity and credential-store posture.",
	},
	history: {
		label: "History stores",
		description: "State metadata, sessions, and cache telemetry availability.",
	},
	models: {
		label: "Targets & models",
		description: "Configured runtime fingerprints and model availability.",
	},
	interoperability: {
		label: "Interoperability",
		description: "Detected and configured external agent surfaces.",
	},
	toolchain: {
		label: "External toolchain",
		description: "Pinned optional programs and the managed file-picker profile.",
	},
	panes: {
		label: "Panes host",
		description: "Multiplexer mode, reachability, protocol level, and journal writability.",
	},
	fleet: {
		label: "Fleet preflight",
		description: "Configured node eligibility checks for the selected project.",
	},
	other: {
		label: "Other checks",
		description: "Additional checks introduced by this Clio Coder version.",
	},
};

const RECOVERY_CHECK_PRESENTATION: Record<
	WireRecoveryCheckLevel,
	{ readonly label: string; readonly tone: string }
> = {
	ok: { label: "Passed", tone: "success" },
	warn: { label: "Warning", tone: "warning" },
	error: { label: "Failed", tone: "error" },
};

function RecoveryPanel({ inspection, pending, onInspect }: {
	inspection: WireRecoveryInspection | null;
	pending: boolean;
	onInspect(): void;
}) {
	return (
		<section
			className="settings__recovery"
			aria-labelledby="settings-recovery-title"
		>
			<div className="settings__section-heading">
				<div>
					<div className="eyebrow">INSTALLATION · REDACTED DIAGNOSTICS</div>
					<h3 id="settings-recovery-title">Clio Coder recovery check</h3>
				</div>
				<p>
					Aggregate health from the machine-readable doctor and path interfaces; raw details remain on the host.
				</p>
			</div>
			<div className="recovery-actions">
				<button
					type="button"
					className="button button--quiet"
					disabled={pending}
					onClick={onInspect}
				>
					{pending ? "Running diagnostics…" : inspection === null ? "Run diagnostics" : "Run diagnostics again"}
				</button>
				{pending && (
					<span role="status">
						Clio Coder is checking the installation. This can take up to one minute.
					</span>
				)}
			</div>
			{inspection === null
				? (
					<p className="settings__note">
						No diagnostic sweep has run in this desktop session. Nothing is inferred from a successful conversation.
					</p>
				)
				: (
					<div
						className="recovery-record"
						aria-label="Clio Coder diagnostic summary"
					>
						<div
							className={`recovery-verdict ${inspection.healthy ? "is-healthy" : "is-failed"}`}
						>
							<div>
								<span>
									{inspection.healthy ? "NO FAILURES" : "ATTENTION REQUIRED"}
								</span>
								<strong>
									{inspection.healthy
										? inspection.summary.warnings === 0
											? "All reported checks passed"
											: `${inspection.summary.warnings} reported warning${inspection.summary.warnings === 1 ? "" : "s"}`
										: `${inspection.summary.failures} reported failure${inspection.summary.failures === 1 ? "" : "s"}`}
								</strong>
							</div>
							<small>
								Inspected {formatTimestamp(inspection.inspectedAt)} ·{" "}
								{inspection.projectContext ? "selected-project context" : "installation context"}
							</small>
						</div>

						<dl className="recovery-summary">
							<div>
								<dt>Checks</dt>
								<dd>{inspection.summary.checks}</dd>
							</div>
							<div>
								<dt>Passed</dt>
								<dd>{inspection.summary.passed}</dd>
							</div>
							<div>
								<dt>Warnings</dt>
								<dd>{inspection.summary.warnings}</dd>
							</div>
							<div>
								<dt>Failures</dt>
								<dd>{inspection.summary.failures}</dd>
							</div>
						</dl>

						<div
							className="recovery-versions"
							aria-label="Diagnostic runtime facts"
						>
							<span>
								Clio Coder <code>{inspection.versions.clioCoder ?? "not reported"}</code>
							</span>
							<span>
								Node <code>{inspection.versions.node ?? "not reported"}</code>
							</span>
							<span>
								Platform <code>{inspection.versions.platform ?? "not reported"}</code>
							</span>
							<span>
								Resolved roots <code>{inspection.pathsResolved}/4</code>
							</span>
						</div>

						<ul className="recovery-sections">
							{inspection.sections.map((section) => {
								const presentation = RECOVERY_SECTION_PRESENTATION[section.id];
								const tone = section.failures > 0 ? "failed" : section.warnings > 0 ? "warning" : "healthy";
								const rows = inspection.checks.filter((check) => check.section === section.id);
								return (
									<li className={`is-${tone}`} key={section.id}>
										<details
											className="recovery-section"
											// A section with something wrong opens itself, because that is the
											// row the operator came here to read.
											open={section.failures > 0 || section.warnings > 0}
										>
											<summary>
												<div>
													<strong>{presentation.label}</strong>
													<p>{presentation.description}</p>
												</div>
												<span>
													{section.passed}/{section.checks} passed
													{section.warnings > 0 ? ` · ${section.warnings} warn` : ""}
													{section.failures > 0 ? ` · ${section.failures} fail` : ""}
												</span>
											</summary>
											{rows.length === 0
												? (
													<p className="recovery-checks__none">
														This sweep reported no individual checks for{" "}
														{presentation.label.toLocaleLowerCase("en-US")}.
													</p>
												)
												: (
													<ul
														className="recovery-checks"
														aria-label={`${presentation.label} diagnostic checks`}
													>
														{rows.map((check, index) => (
															<li
																className={`is-${check.level}`}
																key={`${check.name ?? "unnamed"}:${index}`}
															>
																<span>{check.name ?? "Unnamed check"}</span>
																<StatusMark
																	tone={RECOVERY_CHECK_PRESENTATION[check.level].tone}
																	label={RECOVERY_CHECK_PRESENTATION[check.level].label}
																/>
															</li>
														))}
													</ul>
												)}
										</details>
									</li>
								);
							})}
						</ul>
						{inspection.checksTruncated && (
							<p className="recovery-checks__bound">
								This sweep reported more checks than the bounded record carries. The counts above remain complete.
							</p>
						)}
					</div>
				)}
			<p className="recovery-boundary">
				Each check crosses as its name and verdict only. Native paths, endpoint URLs, socket paths, session and model
				identifiers, commands, and every raw diagnostic detail stay on the host, and a check whose name is not
				name-shaped arrives unnamed rather than blanking the sweep. This check passes no <code>--fix</code>{" "}
				flag and cannot edit settings, though Clio Coder's documented doctor sweep may refresh fleet eligibility facts.
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
		<Modal
			title="Clio Coder settings"
			eyebrow="CONTROLS WITH EXPLICIT SCOPE"
			onClose={onClose}
			size="wide"
		>
			<div className="settings">
				<div className="settings__intro">
					<div>
						<div className="eyebrow">CONFIGURATION</div>
						<h3>How Clio Coder will work</h3>
					</div>
					<p>
						The Clio Coder desktop app reads and writes these values through Clio Coder. Timing labels distinguish this
						session from the next turn or a newly created session.
					</p>
				</div>
				{open === null && <p>Open a project before reading Clio Coder's settings.</p>}
				{open !== null && open.clio.capabilities?.settings !== true && (
					<p className="settings__unavailable">
						This Clio Coder does not expose settings over ACP.
					</p>
				)}
				{open !== null && settings === null &&
					open.clio.capabilities?.settings === true && (
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
								description: "A setting Clio Coder exposes to this desktop app session.",
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
													const patch = settingsPatch(
														key,
														event.target.value,
													);
													if (patch !== null) {
														actions.patchSettings(open.project.id, patch);
													}
												}}
											>
												{(key === "orchestrator.target" ||
													key === "orchestrator.model") && <option value="">unset</option>}
												{options.map((option) => (
													<option value={option} key={option}>
														{option}
													</option>
												))}
											</select>
										)}
									</dd>
								</div>
							);
						})}
					</dl>
				)}
				{busy && (
					<p className="settings__note">
						Settings change between turns. Clio Coder is working right now.
					</p>
				)}

				<ApprovalNotificationSetting
					enabled={state.desktopNotifications}
					onChange={onNotificationsChange}
				/>

				<ToolchainInventory
					inspection={state.toolchainInspection}
					pending={state.pendingToolchainInspect !== null}
					onInspect={actions.inspectToolchain}
				/>

				<RecoveryPanel
					inspection={state.recoveryInspection}
					pending={state.pendingRecoveryInspect !== null}
					onInspect={actions.inspectRecovery}
				/>

				{open !== null && (
					<section
						className="settings__targets"
						aria-labelledby="settings-targets-title"
					>
						<div className="settings__section-heading">
							<div>
								<div className="eyebrow">ROUTING</div>
								<h3 id="settings-targets-title">Configured targets</h3>
							</div>
							<p>
								Health is a point-in-time probe, never an assumed green light.
							</p>
						</div>
						{open.clio.capabilities?.targets !== true
							? (
								<p className="settings__unavailable">
									This Clio Coder does not expose targets over ACP.
								</p>
							)
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
							? (
								<p className="settings__note">
									Clio Coder reports no configured targets.
								</p>
							)
							: (
								<ul className="target-list">
									{targets.map((target) => (
										<TargetRow
											key={target.id}
											target={target}
											projectId={open.project.id}
											actions={actions}
										/>
									))}
								</ul>
							)}
						{open.targetsTruncated && (
							<p className="settings__note">
								This list is shortened; Clio Coder has more targets or models than are shown.
							</p>
						)}
						{targets !== null && targets.length > 0 && (
							<p className="settings__note">
								A target's health is shown only after you probe it.
							</p>
						)}
					</section>
				)}
				{open !== null && (
					<RoutingInventory
						projectId={open.project.id}
						inspection={open.routingInspection}
						pending={state.pendingRoutingInspect !== null}
						onRefresh={actions.inspectRouting}
					/>
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
			if (selectedNode) {
				actions.prepareDelete(
					open.project.id,
					selectedNode.path.segments,
					selectedNode.nodeVersion,
				);
			}
		} else if (dialog === "move") {
			if (!selectedNode || !name.trim()) return;
			actions.moveNode(
				open.project.id,
				selectedNode.path.segments,
				{
					parent: destinationParent.split("/").filter(Boolean),
					name: name.trim(),
				},
				selectedNode.nodeVersion,
			);
		} else {
			if (!name.trim()) return;
			actions.createNode(
				open.project.id,
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
		<Modal
			title={title}
			eyebrow={`PROJECT SCOPE · ${open.project.displayName.toUpperCase()}`}
			onClose={onClose}
		>
			<form className="modal-form" onSubmit={submit}>
				{dialog === "delete"
					? (
						<>
							<p>
								Inspect{" "}
								<code>
									{selectedNode ? formatProjectPath(selectedNode.path) : "no selection"}
								</code>{" "}
								before requesting a one-use confirmation challenge.
							</p>
							<p className="modal-form__warning">
								The GUI deletes files and empty folders only. Symlinks and recursive deletion are blocked.
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
								Destination parent:{" "}
								<code>
									{dialog === "move" ? destinationParent || "/" : parentLabel}
								</code>{" "}
								Existing entries are never overwritten.
							</p>
						</>
					)}
				<div className="modal__actions">
					<button
						type="button"
						className="button button--quiet"
						onClick={onClose}
					>
						Cancel
					</button>
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
	const targetLabel = challenge.targetKind === "empty-directory" ? "empty folder" : "file";
	return (
		<Modal
			title={`Delete ${targetLabel}`}
			eyebrow="ONE-USE CONFIRMATION"
			onClose={onClose}
		>
			<div className="delete-confirmation">
				<div className="delete-confirmation__target">
					<span>TARGET</span>
					<code>{challenge.displayPath}</code>
				</div>
				<p>
					The host bound this challenge to the exact project, path, and inspected node fingerprint.
				</p>
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
					<button
						type="button"
						className="button button--quiet"
						onClick={onClose}
					>
						Keep item
					</button>
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

interface BottomStatusProps {
	state: AppState;
	actions: WorkbenchActions;
	nowMs: number;
	obscured: boolean;
	approvalEscalated: boolean;
}

const BottomStatus = memo(
	function BottomStatus(
		{ state, actions, nowMs, obscured, approvalEscalated }: BottomStatusProps,
	) {
		const open = state.open;
		const session = open?.clio.session ?? null;
		const activeTurn = open?.projection.activeTurn ?? null;
		const activeTurnStartedMs = activeTurn === null ? Number.NaN : Date.parse(activeTurn.startedAt);
		const elapsed = Number.isFinite(activeTurnStartedMs)
			? Math.max(0, Math.floor((nowMs - activeTurnStartedMs) / 1_000))
			: 0;
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
		const autonomyEditable = open !== null && session !== null &&
			open.clio.capabilities?.autonomy === true &&
			!isPromptBlocked(open);
		// Settings describe what Clio Coder would bind next, which is a different fact from
		// what the bound session is running on. Only show it when the two disagree.
		//
		// The two facts reach the bound session on different schedules and must never
		// share a label. Clio Coder reads target and model routing at prompt time, so a
		// patch to either lands on this session's next turn. Autonomy is pinned at
		// session/new for the life of the process, so a patched global autonomy
		// reaches only the next session and the bound one moves through
		// clio-coder/session/autonomy instead.
		const nextTarget = open?.settings?.settings["orchestrator.target"] ?? null;
		const nextModel = open?.settings?.settings["orchestrator.model"] ?? null;
		const nextTurnDiffers = open?.settings != null && session !== null &&
			(nextTarget !== session.target || nextModel !== session.model);
		const settingsAutonomy = open?.settings?.settings["autonomy"] ?? null;
		const nextSessionAutonomy = settingsAutonomy !== null && isAutonomyLevel(settingsAutonomy)
			? settingsAutonomy
			: null;
		const nextSessionDiffers = session !== null &&
			nextSessionAutonomy !== null &&
			nextSessionAutonomy !== session.autonomy;
		return (
			<footer
				className="status-bar"
				aria-label={`${PRODUCT_NAME} status`}
				aria-hidden={obscured ? true : undefined}
				inert={obscured}
			>
				<div className="status-bar__connection">
					<StatusMark
						tone={state.connection === "connected" ? "success" : "error"}
						label={state.connection}
					/>
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
						<strong>
							{`${nextTarget ?? "unselected"} · ${nextModel ?? "unselected"}`}
						</strong>
					</div>
				)}
				{nextSessionDiffers && nextSessionAutonomy !== null && (
					<div className="status-bar__next-session">
						<span>Next session</span>
						<strong>
							{`${AUTONOMY_LABELS[nextSessionAutonomy]} autonomy`}
						</strong>
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
									open &&
									actions.setAutonomy(
										open.project.id,
										event.target.value as WireAutonomyLevel,
									)}
							>
								{(Object.keys(AUTONOMY_LABELS) as WireAutonomyLevel[]).map((
									level,
								) => (
									<option value={level} key={level}>
										{AUTONOMY_LABELS[level]}
									</option>
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
					<strong>
						{approvalEscalated ? `${operation} · escalated` : operation}
					</strong>
				</div>
			</footer>
		);
	},
	sameBottomStatusProps,
);

function sameBottomStatusProps(
	previous: BottomStatusProps,
	next: BottomStatusProps,
): boolean {
	const previousOpen = previous.state.open;
	const nextOpen = next.state.open;
	const sameOpen = previousOpen === nextOpen || (
		previousOpen !== null && nextOpen !== null &&
		previousOpen.project === nextOpen.project &&
		previousOpen.clio === nextOpen.clio &&
		previousOpen.settings === nextOpen.settings &&
		previousOpen.projection.activeTurn === nextOpen.projection.activeTurn
	);
	return sameOpen &&
		previous.state.connection === next.state.connection &&
		previous.state.mode === next.state.mode &&
		previous.actions === next.actions &&
		previous.nowMs === next.nowMs &&
		previous.obscured === next.obscured &&
		previous.approvalEscalated === next.approvalEscalated;
}

export function WorkbenchView(
	{ state, dispatch, actions, initialView = "conversation" }: WorkbenchViewProps,
) {
	const open = state.open;
	const leftRailIsDrawer = useMediaQuery("(max-width: 790px)");
	const evidenceRailIsDrawer = useMediaQuery("(max-width: 1180px)");
	const [fileDialog, setFileDialog] = useState<FileDialog>(null);
	const [selectedNode, setSelectedNode] = useState<WireTreeNode | null>(null);
	const [sessionToDelete, setSessionToDelete] = useState<
		WireSessionSummary | null
	>(null);
	const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false);
	const [projectRailCollapsed, setProjectRailCollapsed] = useState(false);
	const [evidenceRailCollapsed, setEvidenceRailCollapsed] = useState(false);
	const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(
		initialView,
	);
	const automaticallyInspectedProject = useRef<string | null>(null);
	const previousLeftDrawerOpen = useRef(state.leftDrawerOpen);
	const previousEvidenceDrawerOpen = useRef(evidenceDrawerOpen);
	const pendingPermission = open?.projection.pendingPermission ?? null;
	const activeTurn = open?.projection.activeTurn ?? null;
	// One clock for the whole shell, so the banner, the tool cards, and the status
	// bar can never disagree about how long something has been waiting.
	const nowMs = useNow(activeTurn !== null || pendingPermission !== null);
	const approvalEscalated = pendingPermission !== null &&
		nowMs >= Date.parse(pendingPermission.escalateAt);
	const escalatedSeconds = pendingPermission === null ? 0 : Math.max(
		0,
		Math.floor(
			(Date.parse(pendingPermission.escalateAt) -
				Date.parse(pendingPermission.requestedAt)) / 1_000,
		),
	);
	const modalIsOpen = fileDialog !== null || Boolean(open?.deleteChallenge) ||
		state.browse !== null ||
		state.settingsOpen || sessionToDelete !== null;
	const leftDrawerObscures = leftRailIsDrawer && state.leftDrawerOpen;
	const evidenceDrawerObscures = evidenceRailIsDrawer && evidenceDrawerOpen;
	const backgroundObscured = modalIsOpen || leftDrawerObscures ||
		evidenceDrawerObscures;

	useEffect(() => {
		setFileDialog(null);
		setSelectedNode(null);
		setSessionToDelete(null);
		setEvidenceDrawerOpen(false);
		setWorkspaceView("conversation");
	}, [open?.project.id]);

	useEffect(() => {
		if (
			state.connection !== "connected" || open === null ||
			open.configInspection !== null ||
			automaticallyInspectedProject.current === open.project.id
		) return;
		automaticallyInspectedProject.current = open.project.id;
		actions.inspectConfig(open.project.id);
	}, [actions, open?.project.id, state.connection]);

	useEffect(() => {
		if (!evidenceRailIsDrawer) setEvidenceDrawerOpen(false);
	}, [evidenceRailIsDrawer]);

	useEffect(() => {
		if (!leftRailIsDrawer && state.leftDrawerOpen) {
			dispatch({ type: "drawer.left", open: false });
		}
	}, [dispatch, leftRailIsDrawer, state.leftDrawerOpen]);

	useEffect(() => {
		if (leftRailIsDrawer && state.leftDrawerOpen) {
			document.querySelector<HTMLButtonElement>(".left-rail__close")?.focus();
		} else if (leftRailIsDrawer && previousLeftDrawerOpen.current) {
			document.querySelector<HTMLButtonElement>(".mobile-controls button")
				?.focus();
		}
		previousLeftDrawerOpen.current = state.leftDrawerOpen;
	}, [leftRailIsDrawer, state.leftDrawerOpen]);

	useEffect(() => {
		if (evidenceRailIsDrawer && evidenceDrawerOpen) {
			document.querySelector<HTMLButtonElement>(".evidence-rail__close")
				?.focus();
		} else if (evidenceRailIsDrawer && previousEvidenceDrawerOpen.current) {
			document.querySelector<HTMLButtonElement>(
				".mobile-controls--evidence button",
			)?.focus();
		}
		previousEvidenceDrawerOpen.current = evidenceDrawerOpen;
	}, [evidenceDrawerOpen, evidenceRailIsDrawer]);

	const collapseProjectRail = useCallback((): void => {
		setProjectRailCollapsed(true);
		requestAnimationFrame(() =>
			document.querySelector<HTMLButtonElement>(".rail-control--project button")
				?.focus()
		);
	}, []);

	const toggleProjectRail = useCallback((): void => {
		if (leftRailIsDrawer) {
			dispatch({ type: "drawer.left", open: !state.leftDrawerOpen });
			return;
		}
		setProjectRailCollapsed(false);
		requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".left-rail__close")?.focus());
	}, [dispatch, leftRailIsDrawer, state.leftDrawerOpen]);

	const collapseEvidenceRail = useCallback((): void => {
		setEvidenceRailCollapsed(true);
		requestAnimationFrame(() =>
			document.querySelector<HTMLButtonElement>(
				".rail-control--evidence button",
			)?.focus()
		);
	}, []);

	const toggleEvidenceRail = useCallback((): void => {
		if (evidenceRailIsDrawer) {
			setEvidenceDrawerOpen((current) => !current);
			return;
		}
		setEvidenceRailCollapsed(false);
		requestAnimationFrame(() =>
			document.querySelector<HTMLButtonElement>(".evidence-rail__close")
				?.focus()
		);
	}, [evidenceRailIsDrawer]);

	const closeEvidenceDrawer = useCallback(
		(): void => setEvidenceDrawerOpen(false),
		[],
	);

	const changeWorkspaceView = useCallback((view: WorkspaceView): void => {
		setWorkspaceView(view);
		if (
			view === "catalog" && open !== null && open.catalogInspection === null &&
			state.pendingCatalogInspect === null
		) actions.inspectCatalog(open.project.id);
		if (
			view === "usage" && open !== null && open.usageInspection === null &&
			state.pendingUsageInspect === null
		) actions.inspectUsage(open.project.id);
		if (
			view === "dispatch" && state.dispatchInspection === null &&
			state.pendingDispatchInspect === null
		) {
			actions.inspectDispatch();
		}
		if (
			view === "fleet-runs" && state.fleetInspection === null &&
			state.pendingFleetInspect === null
		) {
			actions.inspectFleet();
		}
	}, [
		actions,
		open?.project.id,
		open?.catalogInspection,
		open?.usageInspection,
		state.pendingCatalogInspect,
		state.pendingUsageInspect,
		state.dispatchInspection,
		state.pendingDispatchInspect,
		state.fleetInspection,
		state.pendingFleetInspect,
	]);

	const openConversation = useCallback((): void => {
		setWorkspaceView("conversation");
	}, []);

	const openTimeline = useCallback((): void => {
		setWorkspaceView("timeline");
		setEvidenceDrawerOpen(false);
	}, []);

	const openConfigMap = useCallback((): void => {
		setWorkspaceView("effective-clio-coder");
		setEvidenceDrawerOpen(false);
	}, []);

	const openCatalog = useCallback((): void => {
		changeWorkspaceView("catalog");
		setEvidenceDrawerOpen(false);
	}, [changeWorkspaceView]);

	const openUsage = useCallback((): void => {
		changeWorkspaceView("usage");
		setEvidenceDrawerOpen(false);
	}, [changeWorkspaceView]);

	const openDispatch = useCallback((): void => {
		changeWorkspaceView("dispatch");
		setEvidenceDrawerOpen(false);
	}, [changeWorkspaceView]);

	const refreshConfig = useCallback((): void => {
		if (open !== null) actions.inspectConfig(open.project.id);
	}, [actions, open?.project.id]);

	const refreshCatalog = useCallback((): void => {
		if (open !== null) actions.inspectCatalog(open.project.id);
	}, [actions, open?.project.id]);

	const refreshUsage = useCallback((): void => {
		if (open !== null) actions.inspectUsage(open.project.id);
	}, [actions, open?.project.id]);

	const refreshDispatch = useCallback((): void => {
		actions.inspectDispatch();
	}, [actions]);

	const refreshFleet = useCallback((): void => {
		actions.inspectFleet();
	}, [actions]);

	useEffect(() => {
		if (
			workspaceView !== "fleet-runs" || state.connection !== "connected" ||
			state.fleetInspection === null || state.pendingFleetInspect !== null ||
			!state.fleetInspection.runs.some((run) => !run.terminal)
		) return;
		const timer = setTimeout(() => actions.inspectFleet(), 1_000);
		return () => clearTimeout(timer);
	}, [
		actions,
		state.connection,
		state.fleetInspection,
		state.pendingFleetInspect,
		workspaceView,
	]);

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
		document.title = pendingPermission === null ? PRODUCT_NAME : `● Approval needed — ${PRODUCT_NAME}`;
		return () => {
			document.title = previous;
		};
	}, [pendingPermission?.permissionId ?? null]);

	// Alt+A and Alt+R answer the card from wherever the operator is. Suppressed
	// while a modal is up, so a dialog's own controls stay unambiguous.
	useEffect(() => {
		if (
			pendingPermission === null || activeTurn === null || open === null ||
			modalIsOpen
		) return;
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
	}, [
		actions,
		activeTurn?.turnId,
		modalIsOpen,
		open?.project.id,
		pendingPermission?.permissionId,
	]);

	// One desktop notification per card, and only if permission was already
	// granted. Nothing here ever asks for it; the settings toggle does that.
	useEffect(() => {
		if (pendingPermission === null || !state.desktopNotifications) return;
		if (
			typeof Notification === "undefined" ||
			Notification.permission !== "granted"
		) return;
		try {
			// Title only. A path in a notification would leave the project boundary.
			const posted = new Notification(`${PRODUCT_NAME}: approval needed`, {
				body: pendingPermission.title,
			});
			return () => posted.close();
		} catch {
			// A browser that refuses to construct one is not a Workbench failure.
		}
	}, [pendingPermission?.permissionId ?? null, state.desktopNotifications]);

	if (state.boot === "loading") return <LoadingScreen />;
	if (state.boot === "failed") {
		return (
			<FailureScreen
				message={state.bootError ?? `${PRODUCT_NAME} could not start.`}
			/>
		);
	}

	return (
		<div
			className={`workbench-shell${projectRailCollapsed ? " is-project-rail-collapsed" : ""}${
				evidenceRailCollapsed ? " is-evidence-rail-collapsed" : ""
			}`}
		>
			<div className="ambient-grid" aria-hidden="true" />
			<div className="sr-only" aria-live="assertive" aria-atomic="true">
				{state.announcement}
			</div>
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
				desktopCollapsed={projectRailCollapsed}
				onDesktopCollapse={collapseProjectRail}
				obscured={modalIsOpen || evidenceDrawerObscures}
			/>
			<ConversationCanvas
				state={state}
				dispatch={dispatch}
				actions={actions}
				obscured={backgroundObscured}
				nowMs={nowMs}
				projectRailIsDrawer={leftRailIsDrawer}
				projectRailCollapsed={projectRailCollapsed}
				onProjectRailToggle={toggleProjectRail}
				inspectorIsDrawer={evidenceRailIsDrawer}
				inspectorCollapsed={evidenceRailCollapsed}
				inspectorOpen={evidenceDrawerOpen}
				onInspectorToggle={toggleEvidenceRail}
				workspaceView={workspaceView}
				onWorkspaceViewChange={changeWorkspaceView}
				onConversationOpen={openConversation}
				onRefreshConfig={refreshConfig}
				onRefreshCatalog={refreshCatalog}
				onRefreshUsage={refreshUsage}
				onRefreshDispatch={refreshDispatch}
				onRefreshFleet={refreshFleet}
			/>
			<EvidenceRail
				state={state}
				nowMs={nowMs}
				isDrawer={evidenceRailIsDrawer}
				drawerOpen={evidenceDrawerOpen}
				onClose={closeEvidenceDrawer}
				desktopCollapsed={evidenceRailCollapsed}
				onDesktopCollapse={collapseEvidenceRail}
				workspaceView={workspaceView}
				onOpenConfigMap={openConfigMap}
				onOpenCatalog={openCatalog}
				onOpenUsage={openUsage}
				onOpenDispatch={openDispatch}
				onOpenTimeline={openTimeline}
				obscured={modalIsOpen || leftDrawerObscures}
			/>
			<BottomStatus
				state={state}
				actions={actions}
				nowMs={nowMs}
				obscured={backgroundObscured}
				approvalEscalated={approvalEscalated}
			/>
			{state.notice && (
				<div
					className={`app-notice app-notice--${state.notice.tone}`}
					role="alert"
				>
					<span aria-hidden="true">!</span>
					<p>{state.notice.message}</p>
					<button
						type="button"
						className="icon-button"
						onClick={() => dispatch({ type: "notice.dismissed" })}
					>
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
