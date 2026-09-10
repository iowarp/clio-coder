import type { ClioSettings } from "../core/config.js";
import { readClioVersion } from "../core/package-root.js";
import type { ContextState } from "../domains/context/index.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import { type Component, truncateToWidth, visibleWidth } from "../engine/tui.js";
import {
	brandMark,
	type ClioTheme,
	type ClioToken,
	clioTheme,
	collapseHomePath,
	formatTargetLabel,
	GLYPH,
	padAnsi,
} from "./theme/index.js";

/**
 * What the route can honestly be said to be.
 *
 * `checking` is its own state and is never spelled as ready or unavailable. A
 * target that is configured but not yet probed reports
 * `health.status === "unknown"` with `available` still true, and printing that
 * as either verdict is a claim the process has not earned. `available === false`
 * is a different thing: it is a configuration or auth-level refusal that holds
 * without any probe (see `authStatusFor` in domains/providers/extension.ts), so
 * it is reported as unavailable immediately.
 */
export type WelcomeRouteState = "checking" | "ready" | "degraded" | "unavailable" | "unset";

/**
 * Project-context state, mirroring `ContextState["clioMd"]` plus the honest
 * fourth answer for "the authoritative read has not happened yet". `stale` is
 * carried through rather than folded into `ok`, because a stale CLIO-CODER.md
 * has a different next step than a current one.
 */
export type WelcomeProjectContextState = "checking" | "ok" | "stale" | "none" | "malformed";

export interface WelcomeDashboardDeps {
	providers: Pick<ProvidersContract, "list">;
	getSettings?: () => Readonly<ClioSettings>;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	/**
	 * The authoritative project-context reader from the context domain. It is
	 * synchronous on a cache miss (it walks ancestors for CLIO-CODER.md), so it
	 * is never called from `render`; the dashboard refreshes it off the frame and
	 * paints `checking` until the first reading lands.
	 */
	getContextState?: (cwd: string) => ContextState;
	/** Effective label for the submit binding; null when unbound or disabled. */
	getSubmitKeyLabel?: () => string | null;
	/** Called when an off-render refresh lands, so the frame owner can ask for one. */
	onFactsRefreshed?: () => void;
	/**
	 * How the off-render refresh is deferred. Production yields to the event loop
	 * so no filesystem work ever runs on the render call stack; tests inject a
	 * synchronous runner for determinism.
	 */
	scheduleRefresh?: (run: () => void) => void;
	now?: () => number;
}

export interface WelcomeDashboardStats {
	cwd: string;
	workspace: WorkspaceSnapshot | null;
	/** Null when unset. `formatTargetLabel` owns the one spelling for that. */
	targetLabel: string | null;
	modelLabel: string | null;
	route: WelcomeRouteState;
	/** The actionable half of a failure. Null whenever the route is fine. */
	routeReason: string | null;
	/** `checking` in session mode: the collapsed row does not show it, so it is not read. */
	projectContext: WelcomeProjectContextState;
	/** Null in session mode: the collapsed row prints no key hint. */
	submitKeyLabel: string | null;
}

export type WelcomeDashboardMode = "launchpad" | "session";

export interface WelcomeDashboardComponent extends Component {
	collapseToSessionHeader(): boolean;
	resetToLaunchpad(): boolean;
	/** Stop off-render refreshes from requesting frames after teardown. */
	dispose(): void;
}

/**
 * How long a project-context reading is trusted, and how soon a reading that
 * could not be taken is retried. The retry is shorter than the trust window so a
 * transient failure resolves quickly, and longer than a frame so a permanently
 * failing read cannot become a per-frame scan.
 *
 * A failure never renews the trust window. Once reads have been failing for
 * longer than the window, the header stops asserting the last value and says
 * `checking` instead, so a stale `ok` cannot outlive the evidence for it.
 */
export const WELCOME_PROJECT_CONTEXT_TTL_MS = 10_000;
export const WELCOME_PROJECT_CONTEXT_RETRY_MS = 2_000;

/** Columns the route's failure reason is allowed before it is cut. */
const ROUTE_REASON_MAX = 48;
/** The route text is shrunk to this before a failure reason is cut instead. */
const ROUTE_TARGET_FLOOR = 12;
/** Below this a reason is dropped; the action row still names the fault. */
const ROUTE_REASON_FLOOR = 8;

/**
 * Neutralize a string that came from outside this process before it is styled.
 *
 * Provider reasons, upstream error bodies, branch names, model ids and paths all
 * reach the header from somewhere the header does not control, and a header is a
 * bad place to discover that a payload can move the cursor. `sanitizeCallTargetText`
 * is the project's existing one-line sanitizer (OSC and CSI stripped, C0 and DEL
 * neutralized, whitespace collapsed); this is a thin alias so the intent reads at
 * every call site.
 */
function plainOneLine(value: string): string {
	return sanitizeCallTargetText(value);
}

function findCurrentStatus(
	statuses: ReadonlyArray<TargetStatus>,
	settings: Readonly<ClioSettings> | undefined,
): TargetStatus | null {
	const targetId = settings?.chat?.target ?? null;
	if (!targetId) return null;
	return statuses.find((status) => status.target.id === targetId) ?? null;
}

/**
 * One short line an operator can act on. Reasons arrive as anything from
 * `ECONNREFUSED 127.0.0.1:1234` to a multi-line upstream body, so the text is
 * sanitized to one line and then cut by terminal columns — not by code units,
 * which would split a surrogate pair or a combining sequence.
 */
function shortRouteReason(status: TargetStatus): string | null {
	const cleaned = plainOneLine(status.health.lastError ?? status.reason ?? "");
	if (cleaned.length === 0) return null;
	return visibleWidth(cleaned) > ROUTE_REASON_MAX
		? truncateToWidth(cleaned, ROUTE_REASON_MAX, GLYPH.ellipsis, false)
		: cleaned;
}

function deriveRoute(
	current: TargetStatus | null,
	targetLabel: string | null,
	modelLabel: string | null,
): { route: WelcomeRouteState; routeReason: string | null } {
	// A route needs both halves. A configured target with no model and no default
	// model cannot answer a prompt, so it is unset rather than ready: the previous
	// header advertised `dynamo · no model · ready`, which was never true.
	if (targetLabel === null || modelLabel === null) return { route: "unset", routeReason: null };
	// A target id that matches no listed target is a real misconfiguration, not an
	// unprobed one.
	if (current === null) return { route: "unavailable", routeReason: "no such target in settings" };
	// `available: false` is decided from configuration and auth without probing.
	if (!current.available || current.health.status === "down")
		return { route: "unavailable", routeReason: shortRouteReason(current) };
	if (current.health.status === "degraded") return { route: "degraded", routeReason: shortRouteReason(current) };
	if (current.health.status === "healthy") return { route: "ready", routeReason: null };
	// "unknown": configured and permitted, but no probe has returned a verdict.
	return { route: "checking", routeReason: null };
}

function normalizeProjectContext(state: ContextState | null | undefined): WelcomeProjectContextState | null {
	const value = state?.clioMd;
	if (value === "ok" || value === "stale" || value === "none" || value === "malformed") return value;
	return null;
}

// ---------------------------------------------------------------------------
// Width fitting. Every measurement goes through pi's `visibleWidth`, so ANSI,
// CJK, emoji and combining sequences are counted in terminal columns rather
// than in code units.
// ---------------------------------------------------------------------------

/**
 * Head-truncate a path so the leaf stays whole: `…/iowarp/clio-coder`. The leaf
 * identifies a workspace, and two sibling worktrees differ only there, so it is
 * the last thing given up.
 */
function fitPathTail(path: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(path) <= max) return path;
	const segments = path.split("/").filter((segment) => segment.length > 0);
	const leaf = segments.at(-1) ?? path;
	let best = leaf;
	for (let index = segments.length - 2; index >= 0; index -= 1) {
		const candidate = `${segments[index]}/${best}`;
		if (visibleWidth(`${GLYPH.ellipsis}/${candidate}`) > max) break;
		best = candidate;
	}
	const marked = `${GLYPH.ellipsis}/${best}`;
	if (visibleWidth(marked) <= max) return marked;
	return truncateToWidth(leaf, max, GLYPH.ellipsis, false);
}

interface Unit {
	text: string;
	/** Lower survives longer. Units at or below `protectRank` are never dropped. */
	rank: number;
}

/**
 * Fit `units` into `maxWidth` by dropping whole low-priority units rather than
 * tail-truncating the joined string. Display order is the order given and is
 * independent of rank, so a unit can be shown first and still be the first to go.
 * Protected units that still overflow are truncated with an ellipsis, so the most
 * important fact is partly visible rather than absent — which is what the previous
 * header got wrong: it appended everything and clipped, making the route the first
 * casualty of a long path.
 */
function fitByPriority(theme: ClioTheme, units: ReadonlyArray<Unit>, maxWidth: number, protectRank = 0): string {
	const separator = " · ";
	const sep = theme.fg("dim", separator);
	const sepWidth = visibleWidth(separator);
	const kept = units.map((unit) => ({ ...unit, dropped: false }));
	const total = (): number => {
		const live = kept.filter((unit) => !unit.dropped);
		if (live.length === 0) return 0;
		return live.reduce((sum, unit) => sum + visibleWidth(unit.text), 0) + sepWidth * (live.length - 1);
	};
	while (total() > maxWidth) {
		const droppable = kept.filter((unit) => !unit.dropped && unit.rank > protectRank);
		let worst = droppable[0];
		if (worst === undefined) break;
		for (const unit of droppable) if (unit.rank > worst.rank) worst = unit;
		worst.dropped = true;
	}
	const joined = kept
		.filter((unit) => !unit.dropped)
		.map((unit) => unit.text)
		.join(sep);
	return visibleWidth(joined) <= maxWidth ? joined : truncateToWidth(joined, maxWidth, GLYPH.ellipsis, false);
}

function workspacePath(stats: WelcomeDashboardStats): string {
	return plainOneLine(collapseHomePath(stats.cwd));
}

function workspaceBranch(stats: WelcomeDashboardStats): string | null {
	const workspace = stats.workspace;
	if (workspace?.isGit !== true || !workspace.branch) return null;
	const branch = plainOneLine(workspace.branch);
	return branch.length === 0 ? null : branch;
}

/**
 * The workspace as `path · branch`, giving up the branch before the path's leaf.
 * A branch name can be far longer than the directory it belongs to, and a header
 * showing `feature/some-very-long-branch` while hiding which checkout it belongs
 * to has kept the less useful half.
 */
function workspaceLabel(theme: ClioTheme, stats: WelcomeDashboardStats, room: number): string {
	if (room <= 0) return "";
	const path = workspacePath(stats);
	const branch = workspaceBranch(stats);
	const paint = (text: string): string => theme.fg("muted", text);
	if (branch === null) return paint(fitPathTail(path, room));

	const dirty = stats.workspace?.dirty === true;
	const branchText = `${theme.fg("info", branch)}${dirty ? theme.fg("warning", "*") : ""}`;
	const pathRoom = room - visibleWidth(branch) - (dirty ? 1 : 0) - 3;
	// Keep the branch only while the path's leaf survives whole beside it.
	if (pathRoom > 0) {
		const fitted = fitPathTail(path, pathRoom);
		const leaf =
			path
				.split("/")
				.filter((segment) => segment.length > 0)
				.at(-1) ?? path;
		if (fitted.endsWith(leaf)) return `${paint(fitted)}${theme.fg("dim", " · ")}${branchText}`;
	}
	return paint(fitPathTail(path, room));
}

function routeToken(route: WelcomeRouteState): ClioToken {
	if (route === "ready") return "success";
	if (route === "degraded") return "warning";
	if (route === "unavailable") return "error";
	return "dim";
}

function routeGlyph(route: WelcomeRouteState): string {
	if (route === "ready") return GLYPH.ok;
	if (route === "degraded") return GLYPH.warnInline;
	if (route === "unavailable") return GLYPH.error;
	return GLYPH.queued;
}

/**
 * The route Clio will use, and — only when there is one — why it cannot answer.
 *
 * A failure reason is given room by shrinking the route text down to a floor
 * before the reason is cut at all, because a failure is least useful exactly
 * where the old header made it least visible. Below the floor the reason is
 * truncated rather than dropped, and only when neither fits does the row fall
 * back to the route alone; the action row still names the fault there.
 */
function routeRow(theme: ClioTheme, stats: WelcomeDashboardStats, room: number): string {
	const target = plainOneLine(formatTargetLabel(stats.targetLabel, stats.modelLabel));
	if (stats.route === "unset") return theme.fg("warning", truncateToWidth(target, room, GLYPH.ellipsis, false));
	const token = routeToken(stats.route);
	// A glyph rather than a word, so the verdicts stay distinct with no color.
	const prefix = `${theme.fg(token, routeGlyph(stats.route))} `;
	const available = room - 2;
	if (available <= 0) return theme.fg(token, routeGlyph(stats.route));
	const muted = (text: string): string => theme.fg("muted", text);
	const reason = stats.routeReason;
	if (reason === null) return `${prefix}${muted(truncateToWidth(target, available, GLYPH.ellipsis, false))}`;

	const reasonWidth = visibleWidth(reason);
	if (visibleWidth(target) + 1 + reasonWidth <= available) return `${prefix}${muted(target)} ${theme.fg(token, reason)}`;
	const targetRoom = available - reasonWidth - 1;
	if (targetRoom >= ROUTE_TARGET_FLOOR)
		return `${prefix}${muted(truncateToWidth(target, targetRoom, GLYPH.ellipsis, false))} ${theme.fg(token, reason)}`;
	const floor = Math.min(ROUTE_TARGET_FLOOR, available);
	const reasonRoom = available - floor - 1;
	if (reasonRoom >= ROUTE_REASON_FLOOR) {
		return `${prefix}${muted(truncateToWidth(target, floor, GLYPH.ellipsis, false))} ${theme.fg(token, truncateToWidth(reason, reasonRoom, GLYPH.ellipsis, false))}`;
	}
	return `${prefix}${muted(truncateToWidth(target, available, GLYPH.ellipsis, false))}`;
}

/**
 * The one next step, chosen by what actually blocks work.
 *
 * Route faults outrank project-context state: a task cannot be answered by a
 * route that does not respond. A missing CLIO-CODER.md is guidance rather than a
 * blocker, so it keeps the invitation to work alongside the suggestion. A
 * malformed one is a real fault and points at the read-only `/context` view,
 * never at a command that would regenerate the file the operator still has to
 * repair by hand.
 */
function actionRow(theme: ClioTheme, stats: WelcomeDashboardStats, room: number): string {
	const say = (token: ClioToken, text: string): string =>
		theme.fg(token, truncateToWidth(text, room, GLYPH.ellipsis, false));
	if (stats.route === "unset") {
		// Name the half that is missing; both are fixed at the same surface.
		const detail = stats.targetLabel === null ? "no route selected" : "no model selected";
		return say("warning", `${detail} · /model`);
	}
	if (stats.route === "unavailable") return say("error", "route unavailable · /settings targets");
	if (stats.route === "degraded") return say("warning", "route degraded · /settings targets");
	if (stats.projectContext === "malformed") return say("warning", "CLIO-CODER.md malformed · /context to inspect");
	if (stats.projectContext === "none") return say("dim", "describe a task · /context init to index this repo");
	if (stats.projectContext === "stale") return say("dim", "describe a task · /context refresh to update it");
	// A printed key must be a key that works, so an unbound submit says nothing.
	const send = stats.submitKeyLabel === null ? null : `${stats.submitKeyLabel} to send`;
	return say("dim", ["describe a task", send, "/ for commands"].filter((part) => part !== null).join(" · "));
}

/**
 * The masthead: identity flush left, workspace flush right, a frame-colored rule
 * between them. Exactly one line at every width. The identity gives up its
 * version before its name, because `Clio Coder` identifies the tool and `v0.4.7`
 * only dates it, and gives up its name before its wordmark.
 */
function mastheadRow(theme: ClioTheme, stats: WelcomeDashboardStats, version: string, width: number): string {
	const mark = brandMark(theme);
	const name = theme.style("title", "Clio Coder", { bold: true });
	const identities = [`${mark} ${name} ${theme.fg("dim", `v${version}`)}`, `${mark} ${name}`, mark];
	for (const identity of identities) {
		const identityWidth = visibleWidth(identity);
		// one space, at least two fill columns, one space
		const room = width - identityWidth - 4;
		if (room < 6) continue;
		const workspace = workspaceLabel(theme, stats, room);
		if (workspace.length === 0) continue;
		const fill = width - identityWidth - visibleWidth(workspace) - 2;
		if (fill < 2) continue;
		return `${identity} ${theme.fg("frame", "─".repeat(fill))} ${workspace}`;
	}
	// Too narrow to pair them. The wordmark holds column 0 and the workspace takes
	// what is left; below that, the wordmark alone.
	const markWidth = visibleWidth(mark);
	if (width >= markWidth + 3) {
		const workspace = workspaceLabel(theme, stats, width - markWidth - 1);
		if (workspace.length > 0) return `${mark} ${workspace}`;
	}
	return truncateToWidth(mark, width, "", false);
}

/**
 * The collapsed session header: one live line naming where Clio is working and
 * which route answers.
 *
 * It stays live rather than freezing at first submit, because the operator can
 * change model mid-session and an unlabeled frozen route would be read as the
 * current one. Readiness, latency and onboarding are dropped: the footer and the
 * composer rail own those, and this line's job after the first prompt is
 * identity. Identity sits next to the wordmark when it fits and is the first
 * thing dropped when it does not — display order and drop order are separate.
 */
function sessionRow(theme: ClioTheme, stats: WelcomeDashboardStats, version: string, width: number): string {
	const mark = brandMark(theme);
	const markWidth = visibleWidth(mark);
	if (width <= markWidth + 1) return truncateToWidth(mark, width, "", false);
	const room = width - markWidth - 1;
	const branch = workspaceBranch(stats);
	const units: Unit[] = [
		{ text: `${theme.style("title", "Clio Coder", { bold: true })} ${theme.fg("dim", `v${version}`)}`, rank: 3 },
		{ text: theme.fg("muted", plainOneLine(formatTargetLabel(stats.targetLabel, stats.modelLabel))), rank: 0 },
		{ text: theme.fg("muted", fitPathTail(workspacePath(stats), Math.max(8, Math.floor(room * 0.5)))), rank: 1 },
		...(branch
			? [
					{
						text: `${theme.fg("info", branch)}${stats.workspace?.dirty === true ? theme.fg("warning", "*") : ""}`,
						rank: 2,
					},
				]
			: []),
	];
	return `${mark} ${fitByPriority(theme, units, room)}`;
}

/**
 * Three rows in launchpad mode and one in session mode, at every width and in
 * every fact state. The row count never moves, because the banner sits at line 0
 * and a height change there forces pi-tui to clear and repaint the whole buffer
 * once the transcript has scrolled — and because a header that grows a row when
 * a probe lands makes the first seconds of a session jump.
 */
function buildWelcomeDashboardLines(
	stats: WelcomeDashboardStats,
	version: string,
	width: number,
	mode: WelcomeDashboardMode,
): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
	if (mode === "session") return [padAnsi(sessionRow(theme, stats, version, safeWidth), safeWidth)];
	const indent = safeWidth >= 12 ? "  " : "";
	const room = Math.max(1, safeWidth - indent.length);
	return [
		mastheadRow(theme, stats, version, safeWidth),
		`${indent}${routeRow(theme, stats, room)}`,
		`${indent}${actionRow(theme, stats, room)}`,
	].map((line) => padAnsi(line, safeWidth));
}

/**
 * Everything that can change what the banner prints, flattened to one comparable
 * string. Deliberately short: the previous signature folded in extension counts,
 * task-memory size, capabilities and wiki facts that no render path read, so
 * unrelated background activity invalidated the render cache and rebuilt rows
 * that could not have differed.
 */
function statsSignature(stats: WelcomeDashboardStats): string {
	const workspace = stats.workspace;
	return [
		stats.cwd,
		workspace && `${workspace.isGit}\x01${workspace.branch}\x01${workspace.dirty}`,
		stats.targetLabel,
		stats.modelLabel,
		stats.route,
		stats.routeReason,
		stats.projectContext,
		stats.submitKeyLabel,
	].join("\0");
}

interface ProjectContextReading {
	cwd: string;
	state: WelcomeProjectContextState;
	/** When the last *successful* read landed. Never renewed by a failure. */
	readAt: number;
	/** When the last attempt finished, successful or not. Paces retries. */
	attemptedAt: number;
	/** When the current failure streak began; null while reads succeed. */
	failingSince: number | null;
}

export class WelcomeDashboard implements WelcomeDashboardComponent {
	private cachedRender: { width: number; signature: string; lines: string[] } | null = null;
	private context: ProjectContextReading | null = null;
	/** Single-flight latch: a read slower than the TTL must not stack refreshes. */
	private contextRefreshing = false;
	private pendingTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private mode: WelcomeDashboardMode = "launchpad";
	private readonly now: () => number;
	private readonly schedule: (run: () => void) => void;
	/**
	 * Read once, here, rather than inside a frame: resolving it walks up for
	 * package.json and parses it, which is filesystem work the render path must
	 * not do even once.
	 */
	private readonly version: string;

	constructor(private readonly deps: WelcomeDashboardDeps) {
		this.now = deps.now ?? ((): number => Date.now());
		this.schedule =
			deps.scheduleRefresh ??
			((run: () => void): void => {
				this.pendingTimer = setTimeout(() => {
					this.pendingTimer = null;
					run();
				}, 0);
				this.pendingTimer.unref?.();
			});
		this.version = readClioVersion();
	}

	render(width: number): string[] {
		const stats = this.stats();
		const signature = `${this.mode}\0${statsSignature(stats)}`;
		const cached = this.cachedRender;
		if (cached !== null && cached.width === width && cached.signature === signature) return cached.lines;
		const lines = buildWelcomeDashboardLines(stats, this.version, width, this.mode);
		this.cachedRender = { width, signature, lines };
		return lines;
	}

	/** Collapse once, before first-submit dispatch can append transcript output. */
	collapseToSessionHeader(): boolean {
		if (this.mode === "session") return false;
		this.mode = "session";
		this.cachedRender = null;
		return true;
	}

	/** A genuinely new session gets a fresh launchpad and a fresh one-time transition. */
	resetToLaunchpad(): boolean {
		if (this.mode === "launchpad") return false;
		this.mode = "launchpad";
		this.cachedRender = null;
		return true;
	}

	/**
	 * Drops the rendered lines only. The project-context reading is not
	 * width-dependent, and pi cascades `invalidate` on terminal cell-dimension
	 * reports; dropping the reading there would flash the header back to
	 * `checking` for a fact that had not changed.
	 */
	invalidate(): void {
		this.cachedRender = null;
	}

	/**
	 * After this, a refresh already in flight lands on the floor: it neither
	 * writes state nor asks for a frame from a presentation that is being torn
	 * down.
	 */
	dispose(): void {
		this.disposed = true;
		if (this.pendingTimer !== null) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
	}

	private stats(): WelcomeDashboardStats {
		const settings = this.deps.getSettings?.();
		const statuses = this.deps.providers.list();
		const current = findCurrentStatus(statuses, settings);
		const targetLabel = current?.target.id ?? settings?.chat?.target ?? null;
		const modelLabel = settings?.chat?.model ?? current?.target.defaultModel ?? null;
		const workspace = this.deps.getWorkspaceSnapshot?.() ?? null;
		const cwd = workspace?.cwd ?? process.cwd();
		const { route, routeReason } = deriveRoute(current, targetLabel, modelLabel);
		// The collapsed row prints neither of these, so it does not pay for them:
		// no background context read, and no cache invalidation when either
		// changes while the header cannot show it. `/new` returns to the launchpad
		// and the check resumes on the next frame.
		const launchpad = this.mode === "launchpad";
		return {
			cwd,
			workspace,
			targetLabel,
			modelLabel,
			route,
			routeReason,
			projectContext: launchpad ? this.projectContext(cwd) : "checking",
			submitKeyLabel: launchpad ? (this.deps.getSubmitKeyLabel?.() ?? null) : null,
		};
	}

	/**
	 * Returns immediately, always, and never touches the filesystem. On a miss it
	 * reports `checking` and schedules the authoritative read off the frame. A
	 * reading is only ever served for the cwd it was taken in, so a directory
	 * change reports `checking` again rather than the previous repository's answer.
	 */
	private projectContext(cwd: string): WelcomeProjectContextState {
		const cached = this.context;
		if (cached === null || cached.cwd !== cwd) {
			this.scheduleContextRefresh(cwd);
			return "checking";
		}
		const at = this.now();
		// Reads that have been failing for longer than the trust window stop
		// standing in for a current one. Without this a stale `ok` survives every
		// failed refresh forever.
		if (cached.failingSince !== null && at - cached.failingSince >= WELCOME_PROJECT_CONTEXT_TTL_MS) {
			if (at - cached.attemptedAt >= WELCOME_PROJECT_CONTEXT_RETRY_MS) this.scheduleContextRefresh(cwd);
			return "checking";
		}
		if (at - cached.readAt < WELCOME_PROJECT_CONTEXT_TTL_MS) return cached.state;
		const due = cached.failingSince === null ? cached.attemptedAt : cached.attemptedAt + WELCOME_PROJECT_CONTEXT_RETRY_MS;
		if (at >= due) this.scheduleContextRefresh(cwd);
		// A refresh is in flight or pending; keep showing the last real reading
		// rather than flickering to `checking` on every TTL boundary.
		return cached.state;
	}

	private scheduleContextRefresh(cwd: string): void {
		const read = this.deps.getContextState;
		if (read === undefined || this.contextRefreshing || this.disposed) return;
		this.contextRefreshing = true;
		this.schedule(() => {
			if (this.disposed) {
				this.contextRefreshing = false;
				return;
			}
			let resolved: WelcomeProjectContextState | null = null;
			try {
				resolved = normalizeProjectContext(read(cwd));
			} catch {
				// A read that threw proves nothing about the workspace. Never turn it
				// into `ok` or `none`.
				resolved = null;
			} finally {
				this.contextRefreshing = false;
			}
			if (this.disposed) return;
			const at = this.now();
			// A reading belongs to the directory it was taken in. If cwd moved while
			// this was in flight, the entry is still filed under its own cwd and the
			// next frame will report `checking` for the new one.
			const previous = this.context !== null && this.context.cwd === cwd ? this.context : null;
			this.context =
				resolved === null
					? {
							cwd,
							state: previous?.state ?? "checking",
							// Deliberately not renewed: a failure must not extend the trust
							// window of the value it failed to confirm.
							readAt: previous?.readAt ?? 0,
							attemptedAt: at,
							failingSince: previous?.failingSince ?? at,
						}
					: { cwd, state: resolved, readAt: at, attemptedAt: at, failingSince: null };
			this.cachedRender = null;
			this.deps.onFactsRefreshed?.();
		});
	}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): WelcomeDashboard {
	return new WelcomeDashboard(deps);
}
