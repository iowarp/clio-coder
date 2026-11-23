import { readClioVersionLabel } from "../core/build-info.js";
import type { ClioSettings } from "../core/config.js";
import type { OutputStyle } from "../core/defaults.js";
import { formatCount } from "../core/format-time.js";
import { tierPolicy, tierRevision } from "../core/presentation-tier.js";
import { clioProjectRoot } from "../core/project-root.js";
import { asciiOnly } from "../core/terminal-preferences.js";
import { markProjectSeen, projectSeen } from "../core/welcome-seen.js";
import type { ContextState } from "../domains/context/index.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/index.js";
import { effectiveYoloConfinement } from "../domains/safety/autonomy.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import { type Component, type Keybinding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import {
	brandMark,
	type ClioTheme,
	clioTheme,
	collapseHomePath,
	formatTargetLabel,
	GLYPH,
	meter,
	padAnsi,
} from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";
import {
	paintWelcomeRowWordmark,
	paintWelcomeWordmark,
	WELCOME_WORDMARK,
	WELCOME_WORDMARK_ROW,
	WELCOME_WORDMARK_WIDE,
} from "./welcome-art.js";

/** Reduced terminals and screen readers get the same one-row identity as demo-off. */
function richWelcomeEnabled(demo: boolean | undefined): boolean {
	return demo !== false && !asciiOnly() && process.env.CLIO_CODER_SCREEN_READER !== "1";
}

const WELCOME_TAGLINES = [
	"Ask CLIO Coder how to use or extend it.",
	"The pursuit of excellence does not need justification. Your code does!",
	"Understanding comes before change.",
	"Created by researchers who love to code.",
	"Good work leaves evidence.",
	"Your models. Your code. Your judgment.",
	"Honest limits are part of a useful result.",
] as const;

// Stage 0 and hydration share one choice; redraws and /new keep the launch's line.
const SESSION_TAGLINE = WELCOME_TAGLINES[Math.floor(Math.random() * WELCOME_TAGLINES.length)] ?? WELCOME_TAGLINES[0];

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
	/** Terminal height, which decides whether the launchpad can afford its art. */
	getTerminalRows?: () => number | undefined;
	/** In-memory recipe inventory; excludes internal helper agents. */
	getAgentCount?: () => number;
	getSettings?: () => Readonly<ClioSettings>;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	/**
	 * The authoritative project-context reader from the context domain. It is
	 * synchronous on a cache miss (it walks ancestors for CLIO-CODER.md), so it
	 * is never called from `render`; the dashboard refreshes it off the frame and
	 * paints `checking` until the first reading lands.
	 */
	getContextState?: (cwd: string) => ContextState;
	getProjectPreload?: (cwd: string) => string | null;
	/** Effective label for the submit binding; null when unbound or disabled. */
	getSubmitKeyLabel?: () => string | null;
	/** Effective shortcut labels; null hides an unbound action. */
	getKeyLabel?: (action: Keybinding) => string | null;
	/**
	 * Connected subscription quota, already summarized, or null when nothing is
	 * connected yet. Read synchronously on every frame, so the supplier must
	 * serve a cached value and do its own refreshing off the render path.
	 */
	getQuotaSummary?: () => string | null;
	/**
	 * The reminder that this repository's own configuration is not applied, or
	 * null. Read on every frame, so the supplier serves a cached line.
	 */
	getProjectConfigReminder?: () => string | null;
	/**
	 * Whether default autonomy's shell calls run in the OS sandbox here, or null
	 * while the host probe has not answered. Read on every frame, so it never probes.
	 */
	getShellContained?: () => boolean | null;
	/**
	 * Reads the latest earlier session in `cwd`, off the frame and only on a terminal. Supplied by the hydrated
	 * presentation: session history stays out of the Stage 0 closure this module belongs to.
	 */
	readLastSession?: (cwd: string, now: number) => Promise<WelcomeLastSession | null>;
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
	outputStyle?: OutputStyle;
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
	projectPreload?: string | null;
	/** Null in session mode: the collapsed row prints no key hint. */
	submitKeyLabel: string | null;
	autonomy: string;
	/** The operator's yolo confinement; read only at yolo, absent reads contained. */
	yoloConfinement?: string;
	/** False when default's shell calls run uncontained on this host; absent or null while unknown. */
	shellContained?: boolean | null;
	targets: string;
	fleet: string;
	/** One line of connected subscription usage; null hides the row entirely. */
	quota: string | null;
	/** Project configuration that is not applied, and the command that reviews it. */
	projectConfig?: string | null;
	/** The first launchpad for this project: the stacked wordmark shows at every tier. */
	firstBoot?: boolean;
	/** The route's context window in tokens; absent or null when nothing declared one. */
	contextWindow?: number | null;
	/** The latest earlier session here, `checking` until it is read, null when there is none. */
	lastSession?: WelcomeLastSession | "checking" | null;
	/** The clock the `last here` age is measured against. */
	now?: number;
}

/** The earlier session the `last here` row quotes. */
export interface WelcomeLastSession {
	lastActiveAt: string;
	/** The first operator words, or null when the session withheld them. */
	preview: string | null;
	name: string | null;
}

export type WelcomeDashboardMode = "launchpad" | "session";

export interface WelcomeDashboardComponent extends Component {
	collapseToSessionHeader(): boolean;
	/** The welcome owns idle teaching while its full panel is visible. */
	isLaunchpadVisible?(): boolean;
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
	const separator = ` ${GLYPH.dot} `;
	const sep = theme.fg("annotation", separator);
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
 * The collapsed session header: one live line naming where Clio is working and
 * which route answers.
 *
 * It stays live rather than freezing at first submit, because the operator can
 * change model mid-session and an unlabeled frozen route would be read as the
 * current one. Readiness, latency and onboarding are dropped: the footer and the
 * composer rail own those, and this line's job after the first prompt is
 * identity. The version outlasts workspace details; the route survives even
 * at widths too small for both.
 */
function sessionRow(theme: ClioTheme, stats: WelcomeDashboardStats, version: string, width: number): string {
	const mark = brandMark(theme);
	const markWidth = visibleWidth(mark);
	if (width <= markWidth + 1) return truncateToWidth(mark, width, "", false);
	const room = width - markWidth - 1;
	const versionTag = theme.fg("annotation", `v${version}`);
	const route = theme.fg(
		"footerIdentity",
		plainOneLine(formatTargetLabel(stats.targetLabel, stats.modelLabel, { abbreviate: false })),
	);
	const identity = `${theme.style("wordmark", "CLIO Coder", { bold: true })} ${versionTag}`;
	const units: Unit[] = [
		{
			text: visibleWidth(identity) + visibleWidth(route) + 3 <= room ? identity : versionTag,
			rank: 2,
		},
		{
			text: route,
			rank: 0,
		},
		// Outlasts the identity: it is the one thing on this line the operator has to act on.
		...(stats.projectConfig ? [{ text: theme.fg("warning", plainOneLine(stats.projectConfig)), rank: 1 }] : []),
	];
	return `${mark} ${fitByPriority(theme, units, room)}`;
}

// ---------------------------------------------------------------------------
// The launchpad: the brand and an open fact table, no frame and no rule.
// ---------------------------------------------------------------------------

/** Cells of a fact label: the widest labels, `awareness` and `last here`. */
const FACT_LABEL_WIDTH = 9;
/** Fact rows hang two cells under the header row. */
const FACT_INDENT = 2;
/** Cells between the wordmark and the facts, and between the facts and the `start` column. */
const COLUMN_GAP = 3;
/** Under this many terminal rows every tier shows the compact form (H1). */
const SHORT_TERMINAL_ROWS = 20;
/** Under this many cells a fact label stacks above its value (W1). */
const STACKED_FACT_WIDTH = 44;
/** Rows of the stacked wordmark, and so of a launchpad that shows it. */
const STACKED_ROWS = 11;
/** Columns from which the stacked wordmark uses its wide letters. */
const WIDE_ART_MIN_WIDTH = 100;
/** Columns from which the `start` column may join the facts. */
const WELCOME_START_MIN_WIDTH = 160;

type FactKey = "model" | "autonomy" | "project" | "awareness" | "rules" | "usage" | "last" | "next";
/** Display order under the header. */
const FACT_ORDER: readonly FactKey[] = ["model", "autonomy", "project", "awareness", "rules", "usage", "last", "next"];
/** Lower survives a tighter row cap longer; `next` always stays. */
const FACT_RANK: Readonly<Record<FactKey, number>> = {
	next: 0,
	model: 1,
	autonomy: 2,
	project: 3,
	awareness: 4,
	rules: 5,
	last: 6,
	usage: 7,
};

/**
 * The fact rows the tier's cap leaves room for. The header is the first fact row, so a cap of one keeps the header
 * alone and `next` then speaks only when it blocks, as its own `‖` row.
 */
function keptFacts(cap: number, hasRules: boolean): ReadonlySet<FactKey> {
	const candidates = FACT_ORDER.filter((key) => key !== "rules" || hasRules);
	return new Set([...candidates].sort((a, b) => FACT_RANK[a] - FACT_RANK[b]).slice(0, Math.max(0, cap - 1)));
}

/** The fact-row cap of the launchpad for this tier and terminal height. */
function factCap(style: OutputStyle | undefined, terminalRows: number | undefined): number {
	const short = terminalRows !== undefined && terminalRows < SHORT_TERMINAL_ROWS;
	return tierPolicy(short ? "compact" : (style ?? "standard")).welcomeRows;
}

const START_COMMANDS: ReadonlyArray<readonly [string, string]> = [
	["/help", "every command and key"],
	["/context", "what CLIO Coder knows here"],
	["/usage", "limits and reset times"],
];
const START_KEYS: ReadonlyArray<readonly [Keybinding, string]> = [
	["clio-coder.leader", "every action by letter"],
	["clio-coder.model.select", "switch the model"],
	["clio-coder.thinking.cycle", "cycle thinking effort"],
];
/** The `start` column joins only a fact block at least as tall as it, so it never adds a row. */
const START_ROWS = START_COMMANDS.length + START_KEYS.length;

/** Whether the launchpad at this size shows its own `start` column of commands and keys. */
export function launchpadShowsHints(style: OutputStyle | undefined, width: number, terminalRows?: number): boolean {
	return factCap(style, terminalRows) >= START_ROWS && width >= WELCOME_START_MIN_WIDTH;
}

function startRows(theme: ClioTheme, getKeyLabel: WelcomeDashboardDeps["getKeyLabel"]): string[] {
	const entries = [
		...START_COMMANDS,
		...START_KEYS.flatMap(([action, meaning]) => {
			const label = getKeyLabel?.(action);
			return label ? [[plainOneLine(label), meaning] as const] : [];
		}),
	];
	const keyWidth = Math.max(0, ...entries.map(([key]) => visibleWidth(key)));
	return entries.map(
		([key, meaning], index) =>
			`${theme.fg("fieldName", (index === 0 ? "start" : "").padEnd(FACT_LABEL_WIDTH))}  ${theme.fg("guidance", padAnsi(key, keyWidth))}  ${theme.fg("body", meaning)}`,
	);
}

/**
 * The brand form, from first boot, the terminal's columns and rows, and the fact rows the tier shows. The wordmark
 * is chosen by fit and first boot, never by tier.
 */
type BrandForm = "stacked" | "band-beside" | "band-above" | "mark";

function brandForm(firstBoot: boolean, columns: number, rows: number, factRows: number): BrandForm {
	if (rows < SHORT_TERMINAL_ROWS) return "mark";
	if (firstBoot && columns >= 76 && rows >= 24) return "stacked";
	if (factRows >= STACKED_ROWS && columns >= 76) return "stacked";
	if (factRows >= WELCOME_WORDMARK_ROW.length && columns >= 100) return "band-beside";
	if (columns >= 57 && (rows >= 30 || (firstBoot && columns < 76 && rows >= 24))) return "band-above";
	return "mark";
}

/**
 * Keep the leaf of a path whole and elide its middle: `~/…/proj/standard`. The leaf identifies a workspace, and two
 * sibling worktrees differ only there, so it is the last thing given up.
 */
function fitPath(path: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(path) <= max) return path;
	const root = path.startsWith("~/") ? "~/" : path.startsWith("/") ? "/" : "";
	const segments = path
		.slice(root.length)
		.split("/")
		.filter((segment) => segment.length > 0);
	const leaf = segments.at(-1) ?? path;
	let best = leaf;
	for (let index = segments.length - 2; index >= 0; index -= 1) {
		const candidate = `${segments[index]}/${best}`;
		if (visibleWidth(`${root}${GLYPH.ellipsis}/${candidate}`) > max) break;
		best = candidate;
	}
	for (const marked of [`${root}${GLYPH.ellipsis}/${best}`, `${GLYPH.ellipsis}/${best}`])
		if (visibleWidth(marked) <= max) return marked;
	return truncateToWidth(leaf, max, GLYPH.ellipsis, false);
}

function gitUnits(stats: WelcomeDashboardStats): string[] {
	const workspace = stats.workspace;
	// Before the first probe lands the placeholder says nothing about Git, so it reads as a check in progress.
	if (workspace === null || workspace.pending === true) return ["checking"];
	// A probe that ran out of time is no answer: a real repository read `no Git repository` under load.
	if (workspace.gitUnknown === true) return ["Git did not answer yet"];
	if (!workspace.isGit) return ["no Git repository"];
	return [
		workspaceBranch(stats) || "detached HEAD",
		workspace.dirty === null ? "changes unknown" : workspace.dirty ? "uncommitted changes" : "clean",
		...(workspace.ahead ? [`${workspace.ahead} ahead`] : []),
		...(workspace.behind ? [`${workspace.behind} behind`] : []),
	];
}

function autonomySummary(stats: WelcomeDashboardStats): string {
	const sep = ` ${GLYPH.sep} `;
	if (stats.autonomy !== "yolo") {
		// With no OS sandbox, shell calls keep their approval rails, so only edits are automatic (bt-11 #6).
		if (stats.shellContained === false) return `default${sep}auto edits${sep}no OS sandbox`;
		// Before the cached probe answers, claim only the edits; the shell's containment is not known yet.
		if (stats.shellContained !== true) return `default${sep}auto edits`;
		return `default${sep}auto in workspace`;
	}
	return stats.yoloConfinement === "unconfined"
		? `yolo${sep}UNCONFINED${sep}never asks`
		: `yolo${sep}contained${sep}never waits`;
}

function awarenessLabel(state: WelcomeProjectContextState): string {
	return {
		checking: "checking",
		ok: "up to date",
		stale: "out of date",
		none: "not indexed yet",
		malformed: "CLIO-CODER.md needs repair",
	}[state];
}

/** The single action that most improves the session, and whether it blocks. */
interface NextStep {
	action: string;
	/** What waits on it; empty when the action says it all. */
	effect: string;
	blocks: boolean;
}

/** Steps that block work, worst first: a route that cannot answer, then project configuration that is not applied. */
function blockers(stats: WelcomeDashboardStats): NextStep[] {
	const steps: NextStep[] = [];
	if (stats.route === "unset")
		steps.push({ action: "/config connects a model", effect: "nothing can run until one is connected", blocks: true });
	if (stats.route === "unavailable")
		steps.push({ action: "/config repairs the route", effect: "nothing can run until it answers", blocks: true });
	if (stats.projectConfig) steps.push({ action: plainOneLine(stats.projectConfig), effect: "", blocks: true });
	return steps;
}

function optionalStep(stats: WelcomeDashboardStats, getKeyLabel: WelcomeDashboardDeps["getKeyLabel"]): NextStep {
	if (stats.projectContext === "none")
		return { action: "/context init indexes this repo", effect: "optional", blocks: false };
	if (stats.projectContext === "stale")
		return { action: "/context refresh updates project awareness", effect: "optional", blocks: false };
	if (stats.projectContext === "malformed")
		return { action: "/context shows what CLIO-CODER.md needs", effect: "optional", blocks: false };
	const leader = getKeyLabel?.("clio-coder.leader");
	const keys = ["? keys", "/ commands", ...(leader ? [`${plainOneLine(leader)} actions`] : [])];
	return { action: keys.join(` ${GLYPH.sep} `), effect: "", blocks: false };
}

/** `‖ action · effect`, dropping the effect before the action is cut. Nothing the operator must act on is dim. */
function stepText(theme: ClioTheme, step: NextStep, room: number): string {
	const lead = step.blocks ? `${theme.fg("attention", GLYPH.phaseBlocked)} ` : "";
	const units: Unit[] = [
		{ text: theme.fg(step.blocks ? "body" : "guidance", step.action), rank: 0 },
		...(step.effect ? [{ text: theme.fg(step.blocks ? "body" : "annotation", step.effect), rank: 1 }] : []),
	];
	return `${lead}${fitByPriority(theme, units, Math.max(1, room - visibleWidth(lead)))}`;
}

function routeText(stats: WelcomeDashboardStats): string {
	if (stats.targetLabel === null && stats.modelLabel === null) return "no model connected";
	return plainOneLine(formatTargetLabel(stats.targetLabel, stats.modelLabel, { abbreviate: false }));
}

/** The route's verdict when it is adverse, at every tier; the reason drops before the verdict. */
function routeFault(theme: ClioTheme, stats: WelcomeDashboardStats): Unit[] {
	const reason = stats.routeReason ? [{ text: theme.fg("body", plainOneLine(stats.routeReason)), rank: 2 }] : [];
	if (stats.route === "unavailable")
		return [{ text: theme.fg("error", `${GLYPH.error} unavailable`), rank: 1 }, ...reason];
	if (stats.route === "degraded") return [{ text: theme.fg("warning", `${GLYPH.warn} degraded`), rank: 1 }, ...reason];
	return [];
}

function modelValue(theme: ClioTheme, stats: WelcomeDashboardStats, health: boolean, room: number): string {
	if (stats.route === "unset")
		return truncateToWidth(theme.fg("warning", routeText(stats)), room, GLYPH.ellipsis, false);
	const window =
		stats.contextWindow !== undefined && stats.contextWindow !== null && stats.contextWindow > 0
			? [{ text: theme.fg("annotation", `${formatCount(stats.contextWindow)} context`), rank: 3 }]
			: [];
	const verdict =
		health && stats.route === "ready"
			? [{ text: theme.fg("success", `${GLYPH.ok} healthy`), rank: 4 }]
			: health && stats.route === "checking"
				? [{ text: theme.fg("annotation", "checking"), rank: 4 }]
				: [];
	return fitByPriority(
		theme,
		[{ text: theme.fg("footerIdentity", routeText(stats)), rank: 0 }, ...window, ...routeFault(theme, stats), ...verdict],
		room,
	);
}

function projectValue(theme: ClioTheme, stats: WelcomeDashboardStats, room: number): string {
	const sep = theme.fg("annotation", ` ${GLYPH.sep} `);
	const git = gitUnits(stats);
	const path = workspacePath(stats);
	// The path keeps at least its leaf's worth of room; Git facts give way from the right before it is cut further.
	for (let count = git.length; count >= 0; count -= 1) {
		const tail = git.slice(0, count).join(` ${GLYPH.sep} `);
		const pathRoom = room - (tail ? visibleWidth(tail) + 3 : 0);
		if (count > 0 && pathRoom < Math.min(visibleWidth(path), 16)) continue;
		const shown = theme.fg("workspacePath", fitPath(path, pathRoom));
		return tail ? `${shown}${sep}${theme.fg("body", tail)}` : shown;
	}
	return theme.fg("workspacePath", fitPath(path, room));
}

/** The files the project instructions came from, then what the preload says about them, dropped before it is cut. */
function rulesValue(theme: ClioTheme, preload: string, room: number): string {
	const text = sanitizeCallTargetText(preload);
	const split = text.indexOf(": ");
	const files = split > 0 ? text.slice(0, split) : text;
	const note = split > 0 ? text.slice(split + 2) : "";
	return fitByPriority(
		theme,
		[{ text: theme.fg("body", files), rank: 0 }, ...(note ? [{ text: theme.fg("annotation", note), rank: 1 }] : [])],
		room,
	);
}

/** A meter of the most-used subscription window, then the windows themselves, dropped whole from the right. */
function usageValue(theme: ClioTheme, stats: WelcomeDashboardStats, room: number): string {
	if (stats.quota === null) return theme.fg("annotation", "no subscription window reported");
	const summary = sanitizeCallTargetText(stats.quota).replace(/% used/g, "%");
	const used = Math.max(0, ...[...summary.matchAll(/(\d+(?:\.\d+)?)%/gu)].map((found) => Number(found[1])));
	const bar = 10;
	const units = summary.split(` ${GLYPH.dot} `).map((text, index) => ({ text: theme.fg("body", text), rank: index }));
	const words = fitByPriority(theme, units, Math.max(1, room - bar - 1));
	return `${meter(theme, { value: used, max: 100, width: bar, amount: "" })} ${words}`;
}

function relativeAge(iso: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (!Number.isFinite(minutes)) return "earlier";
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** `11m ago · "first words…" · -c resumes`; only the quote is ever cut. */
function lastValue(theme: ClioTheme, stats: WelcomeDashboardStats, room: number): string {
	const last = stats.lastSession;
	if (last === undefined || last === "checking") return theme.fg("annotation", "checking");
	if (last === null) return theme.fg("annotation", "no earlier session here");
	const sep = ` ${GLYPH.sep} `;
	const age = relativeAge(last.lastActiveAt, stats.now ?? Date.now());
	const resume = "-c resumes";
	const words = last.preview ?? last.name;
	const quoteRoom = room - visibleWidth(age) - visibleWidth(resume) - 2 * visibleWidth(sep) - 2;
	const quote =
		words && quoteRoom >= 8 ? [`"${truncateToWidth(plainOneLine(words), quoteRoom, GLYPH.ellipsis, false)}"`] : [];
	return fitByPriority(
		theme,
		[
			{ text: theme.fg("body", age), rank: 0 },
			...quote.map((text) => ({ text: theme.fg("body", text), rank: 2 })),
			{ text: theme.fg("guidance", resume), rank: 1 },
		],
		room,
	);
}

/**
 * The header row: the mark, the name and the version, and at compact the route. Beside the stacked wordmark the
 * route takes its own row before the version shortens; elsewhere the build note goes first, then the version.
 */
function headerRows(theme: ClioTheme, version: string, room: number, route: string | null, split: boolean): string[] {
	const mark = brandMark(theme);
	const name = theme.style("wordmark", "CLIO Coder", { bold: true });
	const short = version.replace(/ · .*$/u, "");
	const identities = [`${name} ${theme.fg("annotation", version)}`, `${name} ${theme.fg("annotation", short)}`, name];
	const sep = theme.fg("annotation", ` ${GLYPH.sep} `);
	const fits = (text: string): boolean => visibleWidth(text) <= room;
	if (route === null) {
		for (const identity of identities) if (fits(`${mark} ${identity}`)) return [`${mark} ${identity}`];
		return [truncateToWidth(mark, room, "", false)];
	}
	const [full] = identities;
	if (full !== undefined && fits(`${mark} ${full}${sep}${route}`)) return [`${mark} ${full}${sep}${route}`];
	if (split && full !== undefined && fits(`${mark} ${full}`))
		return [`${mark} ${full}`, truncateToWidth(route, room, GLYPH.ellipsis, false)];
	for (const identity of identities.slice(1))
		if (fits(`${mark} ${identity}${sep}${route}`)) return [`${mark} ${identity}${sep}${route}`];
	return [truncateToWidth(`${mark} ${route}`, room, GLYPH.ellipsis, false)];
}

function launchpadFacts(
	theme: ClioTheme,
	stats: WelcomeDashboardStats,
	version: string,
	width: number,
	cap: number,
	split: boolean,
	getKeyLabel: WelcomeDashboardDeps["getKeyLabel"],
	/** Physical rows a W1 launchpad may take: whole facts give way from the bottom and `next` stays. */
	limit = Number.MAX_SAFE_INTEGER,
): string[] {
	const kept = keptFacts(cap, Boolean(stats.projectPreload));
	const blocked = blockers(stats);
	const compact = !kept.has("next");
	const stackLabels = width < STACKED_FACT_WIDTH;
	const valueRoom = Math.max(1, stackLabels ? width - FACT_INDENT : width - FACT_INDENT - FACT_LABEL_WIDTH - 2);
	const compactRoute = compact
		? fitByPriority(
				theme,
				[
					{ text: theme.fg(stats.route === "unset" ? "warning" : "footerIdentity", routeText(stats)), rank: 0 },
					...routeFault(theme, stats),
				],
				Number.MAX_SAFE_INTEGER,
			)
		: null;
	const header =
		stackLabels && compactRoute !== null
			? [...headerRows(theme, version, width, null, false), ...wrapTextWithAnsi(compactRoute, width)]
			: headerRows(theme, version, width, compactRoute, split);
	if (compact) {
		return [...header, ...blocked.map((step) => stepText(theme, step, width))];
	}
	const indent = " ".repeat(FACT_INDENT);
	const fact = (label: string, value: string): string[] =>
		stackLabels
			? [`${indent}${theme.fg("fieldName", label)}`, ...wrapTextWithAnsi(value, valueRoom).map((row) => `${indent}${row}`)]
			: [`${indent}${theme.fg("fieldName", label.padEnd(FACT_LABEL_WIDTH))}  ${value}`];
	const values: Record<FactKey, () => string> = {
		model: () => modelValue(theme, stats, kept.has("awareness"), stackLabels ? Number.MAX_SAFE_INTEGER : valueRoom),
		autonomy: () =>
			theme.fg(
				stats.autonomy === "yolo" ? "warning" : "body",
				truncateToWidth(autonomySummary(stats), valueRoom, GLYPH.ellipsis, false),
			),
		project: () => projectValue(theme, stats, valueRoom),
		awareness: () =>
			theme.fg(
				stats.projectContext === "stale" || stats.projectContext === "malformed" ? "warning" : "body",
				awarenessLabel(stats.projectContext),
			),
		rules: () => rulesValue(theme, stats.projectPreload ?? "", valueRoom),
		usage: () => usageValue(theme, stats, valueRoom),
		last: () => lastValue(theme, stats, valueRoom),
		next: () => stepText(theme, blocked[0] ?? optionalStep(stats, getKeyLabel), valueRoom),
	};
	const labels: Record<FactKey, string> = {
		model: "model",
		autonomy: "autonomy",
		project: "project",
		awareness: "awareness",
		rules: "rules",
		usage: "usage",
		last: "last here",
		next: "next",
	};
	const groups = FACT_ORDER.filter((key) => kept.has(key) && key !== "next").map((key) =>
		fact(labels[key], values[key]()),
	);
	// A second blocker still speaks: state is never cut by the row cap.
	const more = blocked
		.slice(1)
		.map((step) =>
			stackLabels
				? `${indent}${stepText(theme, step, valueRoom)}`
				: `${indent}${" ".repeat(FACT_LABEL_WIDTH + 2)}${stepText(theme, step, valueRoom)}`,
		);
	const next = [...fact(labels.next, values.next()), ...more];
	const body: string[] = [];
	for (const group of groups) {
		if (stackLabels && header.length + body.length + group.length + next.length > limit) break;
		body.push(...group);
	}
	return [...header, ...body, ...next];
}

export function buildWelcomeDashboardLines(
	stats: WelcomeDashboardStats,
	versionLabel: string,
	width: number,
	mode: WelcomeDashboardMode,
	getKeyLabel?: WelcomeDashboardDeps["getKeyLabel"],
	tagline = SESSION_TAGLINE,
	terminalRows?: number,
): string[] {
	const version = versionLabel.replace(/ \(unreleased(?: · ([^)]+))?\)$/u, (_match, commit: string | undefined) =>
		commit ? ` ${GLYPH.sep} ${commit}` : "",
	);
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
	if (mode === "session") {
		const coverage = stats.projectPreload
			? wrapTextWithAnsi(
					`${theme.fg("fieldName", "Instructions  ")}${theme.fg("body", sanitizeCallTargetText(stats.projectPreload))}`,
					safeWidth,
				)
			: [];
		return [padAnsi(sessionRow(theme, stats, version, safeWidth), safeWidth), ...coverage];
	}
	const rows = terminalRows ?? Number.MAX_SAFE_INTEGER;
	const cap = factCap(stats.outputStyle, terminalRows);
	const firstBoot = stats.firstBoot === true;
	// The form is chosen from the facts as the full width would hold them; a beside form then narrows them.
	const probe = launchpadFacts(theme, stats, version, safeWidth, cap, false, getKeyLabel);
	const form = brandForm(firstBoot, safeWidth, rows, probe.length);
	const art =
		form === "stacked"
			? paintWelcomeWordmark(safeWidth >= WIDE_ART_MIN_WIDTH ? WELCOME_WORDMARK_WIDE : WELCOME_WORDMARK, theme)
			: form === "band-beside" || form === "band-above"
				? paintWelcomeRowWordmark(theme)
				: [];
	const artWidth = form === "stacked" || form === "band-beside" ? visibleWidth(art[0] ?? "") : 0;
	const factStart = artWidth > 0 ? artWidth + COLUMN_GAP : 0;
	let factWidth = safeWidth - factStart;
	// Priority when they compete for width: the facts, then the wordmark, then `start`.
	const start = launchpadShowsHints(stats.outputStyle, safeWidth, terminalRows) ? startRows(theme, getKeyLabel) : [];
	const startWidth = Math.max(0, ...start.map((row) => visibleWidth(row)));
	// `start` joins only where the facts keep their natural width beside it.
	const factsNatural = Math.max(0, ...probe.map((row) => visibleWidth(row)));
	const showStart = start.length > 0 && factWidth - startWidth - COLUMN_GAP >= factsNatural;
	if (showStart) factWidth -= startWidth + COLUMN_GAP;
	// At W1 labels stack and routes wrap, so the launchpad is cut at half the terminal with `next` kept. An unknown
	// height is cut as the smallest standard terminal would be.
	const facts = launchpadFacts(
		theme,
		stats,
		version,
		factWidth,
		cap,
		form === "stacked",
		getKeyLabel,
		Math.floor((terminalRows ?? 24) / 2),
	);
	let block = facts.map((row) => truncateToWidth(row, factWidth, GLYPH.ellipsis, false));
	if (showStart) {
		const factsWidth = Math.max(0, ...block.map((row) => visibleWidth(row)));
		const height = Math.max(block.length, start.length);
		block = Array.from({ length: height }, (_, index) => {
			const right = start[index];
			return right === undefined
				? (block[index] ?? "")
				: `${padAnsi(block[index] ?? "", factsWidth)}${" ".repeat(COLUMN_GAP)}${right}`;
		});
	}
	const besideArt = (lines: readonly string[], offset: number): string[] =>
		Array.from({ length: Math.max(art.length, lines.length + offset) }, (_, index) => {
			const fact = lines[index - offset] ?? "";
			const mark = art[index] ?? "";
			return fact === "" ? mark : `${padAnsi(mark, artWidth)}${" ".repeat(COLUMN_GAP)}${fact}`;
		});
	let lines: string[];
	if (form === "stacked") {
		// The rotating tagline shows only beside the stacked wordmark, and only when the art still bounds the height.
		const taglineRows = wrapTextWithAnsi(theme.fg("body", tagline), Math.max(1, factWidth));
		const withTagline = block.length + taglineRows.length <= STACKED_ROWS ? [...block, ...taglineRows] : block;
		lines = besideArt(withTagline, Math.max(0, Math.floor((STACKED_ROWS - withTagline.length) / 2)));
	} else if (form === "band-beside") lines = besideArt(block, 0);
	else lines = [...art, ...block];
	return lines.map((line) => truncateToWidth(line, safeWidth, GLYPH.ellipsis, false));
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
		workspace &&
			`${workspace.isGit}\x01${workspace.branch}\x01${workspace.dirty}\x01${workspace.ahead}\x01${workspace.behind}\x01${workspace.pending}\x01${workspace.gitUnknown}`,
		stats.targetLabel,
		stats.modelLabel,
		stats.route,
		stats.routeReason,
		stats.projectContext,
		stats.projectPreload,
		stats.autonomy,
		stats.yoloConfinement,
		stats.shellContained,
		stats.outputStyle,
		stats.quota,
		stats.projectConfig,
		stats.firstBoot,
		stats.contextWindow,
		stats.lastSession === undefined || stats.lastSession === null || typeof stats.lastSession === "string"
			? stats.lastSession
			: `${stats.lastSession.lastActiveAt}\x01${stats.lastSession.preview}\x01${stats.lastSession.name}`,
	].join("\0");
}

const launchRoots = new Map<string, string>();
function launchRoot(cwd: string): string {
	let root = launchRoots.get(cwd);
	if (root === undefined) {
		root = clioProjectRoot(cwd);
		launchRoots.set(cwd, root);
	}
	return root;
}

/**
 * Whether this launch is the project's first. Only a launchpad painted on a terminal counts, so a piped process
 * neither reads nor writes the marker and never decides a project's first boot.
 */
function firstBootHere(): boolean {
	return process.stdout.isTTY === true && !projectSeen(launchRoot(process.cwd()));
}

const markedRoots = new Set<string>();
/** Records the first launchpad after it painted, off the frame that painted it. */
function noteLaunchpadPainted(): void {
	if (process.stdout.isTTY !== true) return;
	const root = launchRoot(process.cwd());
	if (markedRoots.has(root)) return;
	markedRoots.add(root);
	setTimeout(() => markProjectSeen(root), 0).unref?.();
}

interface ProjectContextReading {
	cwd: string;
	state: WelcomeProjectContextState;
	preload: string | null;
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
	private last: { cwd: string; value: WelcomeLastSession | null } | null = null;
	private lastReading = false;
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
		this.version = readClioVersionLabel();
	}

	render(width: number): string[] {
		const settings = this.deps.getSettings?.();
		const mode = richWelcomeEnabled(settings?.interface?.demo) ? this.mode : "session";
		const terminalRows = this.deps.getTerminalRows?.();
		const stats = this.stats(mode, terminalRows);
		const keySignature =
			mode === "launchpad"
				? (["clio-coder.leader", "clio-coder.model.select", "clio-coder.thinking.cycle"] as const)
						.map((action) => this.deps.getKeyLabel?.(action))
						.join("|")
				: "";
		const signature = `${skinEpoch()}\0${tierRevision()}\0${mode}\0${statsSignature(stats)}\0${keySignature}\0${terminalRows}`;
		const cached = this.cachedRender;
		if (cached !== null && cached.width === width && cached.signature === signature) return cached.lines;
		const lines = buildWelcomeDashboardLines(
			stats,
			this.version,
			width,
			mode,
			this.deps.getKeyLabel,
			SESSION_TAGLINE,
			terminalRows,
		);
		this.cachedRender = { width, signature, lines };
		if (mode === "launchpad") noteLaunchpadPainted();
		return lines;
	}

	isLaunchpadVisible(): boolean {
		const settings = this.deps.getSettings?.();
		return this.mode === "launchpad" && richWelcomeEnabled(settings?.interface?.demo);
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
		this.context = null;
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

	private stats(mode: WelcomeDashboardMode, terminalRows: number | undefined): WelcomeDashboardStats {
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
		const launchpad = mode === "launchpad";
		const outputStyle = settings?.interface?.outputDetail ?? "standard";
		const preload = launchpad && this.context?.cwd === cwd ? this.context.preload : null;
		// Only facts a row shows are read: usage and the earlier session cost a provider read and a history scan.
		const kept = launchpad ? keptFacts(factCap(outputStyle, terminalRows), Boolean(preload)) : new Set<FactKey>();
		const window = current?.contextWindowProvenance === "runtime-default" ? null : current?.capabilities.contextWindow;
		return {
			outputStyle,
			firstBoot: launchpad && firstBootHere(),
			contextWindow: typeof window === "number" && window > 0 ? window : null,
			...(kept.has("last") ? { lastSession: this.lastSessionFor(cwd), now: this.now() } : {}),
			cwd,
			workspace,
			targetLabel,
			modelLabel,
			route,
			routeReason,
			projectContext: launchpad ? this.projectContext(cwd) : "checking",
			projectPreload: preload,
			submitKeyLabel: null,
			autonomy: settings?.safety?.autonomy ?? "default",
			yoloConfinement: effectiveYoloConfinement(settings?.safety),
			shellContained: this.deps.getShellContained?.() ?? null,
			quota: kept.has("usage") ? (this.deps.getQuotaSummary?.() ?? null) : null,
			targets: "",
			fleet: "",
			projectConfig: this.deps.getProjectConfigReminder?.() ?? null,
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

	/**
	 * The earlier session, or `checking` while its read is pending. The read runs once per directory off the frame;
	 * off a terminal it never runs, since a piped process has no launchpad an operator reads.
	 */
	private lastSessionFor(cwd: string): WelcomeLastSession | null | "checking" {
		if (this.last?.cwd === cwd) return this.last.value;
		const read = process.stdout.isTTY === true ? this.deps.readLastSession : undefined;
		if (read === undefined || this.lastReading || this.disposed) return "checking";
		this.lastReading = true;
		this.schedule(() => {
			void read(cwd, this.now())
				.catch(() => null)
				.then((value) => {
					this.lastReading = false;
					if (this.disposed) return;
					this.last = { cwd, value };
					this.cachedRender = null;
					this.deps.onFactsRefreshed?.();
				});
		});
		return "checking";
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
			let preload: string | null = null;
			try {
				resolved = normalizeProjectContext(read(cwd));
				preload = this.deps.getProjectPreload?.(cwd) ?? null;
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
							preload: previous?.preload ?? null,
							// Deliberately not renewed: a failure must not extend the trust
							// window of the value it failed to confirm.
							readAt: previous?.readAt ?? 0,
							attemptedAt: at,
							failingSince: previous?.failingSince ?? at,
						}
					: { cwd, state: resolved, preload, readAt: at, attemptedAt: at, failingSince: null };
			this.cachedRender = null;
			this.deps.onFactsRefreshed?.();
		});
	}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): WelcomeDashboard {
	return new WelcomeDashboard(deps);
}

/** Same welcome geometry before hydration, using only the settings already read. */
export function createBootWelcome(
	settings: Readonly<ClioSettings>,
	submitKeyLabel: string | null,
	getKeyLabel?: WelcomeDashboardDeps["getKeyLabel"],
): Component {
	const target = settings.targets.find((entry) => entry.id === settings.chat.target);
	const model = settings.chat.model ?? target?.defaultModel ?? null;
	const version = readClioVersionLabel();
	const mode = richWelcomeEnabled(settings.interface.demo) ? "launchpad" : "session";
	const stats: WelcomeDashboardStats = {
		outputStyle: settings.interface.outputDetail,
		firstBoot: mode === "launchpad" && firstBootHere(),
		lastSession: "checking",
		cwd: process.cwd(),
		workspace: null,
		targetLabel: settings.chat.target ?? null,
		modelLabel: model,
		route: target && model ? "checking" : "unset",
		routeReason: null,
		projectContext: "checking",
		submitKeyLabel,
		// Boot reserves the quota slots without making a provider read.
		quota: null,
		autonomy: settings.safety.autonomy,
		yoloConfinement: effectiveYoloConfinement(settings.safety),
		targets: "",
		fleet: "",
	};
	let cached: { width: number; rows: number; epoch: number; lines: string[] } | null = null;
	return {
		render: (width) => {
			const rows = process.stdout.rows;
			if (cached?.width === width && cached.rows === rows && cached.epoch === skinEpoch()) return cached.lines;
			const lines = buildWelcomeDashboardLines(stats, version, width, mode, getKeyLabel, SESSION_TAGLINE, rows);
			cached = { width, rows, epoch: skinEpoch(), lines };
			if (mode === "launchpad") noteLaunchpadPainted();
			return lines;
		},
		invalidate: () => {
			cached = null;
		},
	};
}
