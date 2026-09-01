import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { readClioVersion } from "../core/package-root.js";
import { loadProjectClioMd } from "../domains/context/clio-md.js";
import { readCodewiki, readCodewikiAsync } from "../domains/context/codewiki/artifact.js";
import { renderCodewikiDigest } from "../domains/context/codewiki/digest.js";
import { listWikiPages } from "../domains/context/wiki/layout.js";
import {
	type WikiStaleness,
	wikiCompleteness,
	wikiStaleness,
	wikiStalenessAsync,
} from "../domains/context/wiki/staleness.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import {
	type CapabilityFlags,
	type ProvidersContract,
	resolveModelCapabilities,
	resolveModelRuntimeCapabilitiesForProviders,
	type TargetStatus,
} from "../domains/providers/index.js";
import type { ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import { type Component, truncateToWidth } from "../engine/tui.js";
import { relative } from "./format-time.js";
import { brandMark, clioTheme, formatTargetLabel, frame, GLYPH, sectionTag } from "./theme/index.js";

export interface WelcomeDashboardDeps {
	providers: ProvidersContract;
	observability: ObservabilityContract;
	getContextUsage?: () => ContextUsageSnapshot;
	getSettings?: () => Readonly<ClioSettings>;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	getExtensionStats?: () => { active: number; installed: number };
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	/** Overridable repository probe. Tests count calls through it; production uses the default. */
	readRepositoryFacts?: (cwd: string) => WelcomeRepositoryFacts;
	/** Called when an off-render probe lands, so the layer that owns the frame can ask for one. */
	onFactsRefreshed?: () => void;
}

/**
 * The part of the banner that costs subprocesses and disk reads rather than a
 * map lookup: CLIO-CODER.md presence, the codewiki, wiki staleness and completeness,
 * and the handoff directory. None of it can change as a result of drawing a
 * frame, and re-deriving it per frame ran three `git` subprocesses and a full
 * codewiki parse inside the render timer.
 */
export interface WelcomeRepositoryFacts {
	clioMdStatus: string;
	hasCodewiki: boolean;
	codewikiCount: number;
	wikiPageCount: number;
	wikiStatus: string;
	wikiDigestExcerpt: string[];
	handoffCount: number;
	handoffFreshness: string;
	/**
	 * True while the first probe is still in flight. The rows that depend on it
	 * render dim placeholders rather than wrong values, and keep their row count,
	 * because the banner sits at line 0 and a height change there forces pi-tui
	 * to clear and repaint the entire buffer once the transcript has scrolled.
	 */
	pending?: boolean;
}

export interface WelcomeDashboardStats {
	activeTargets: number;
	totalTargets: number;
	/** Null when unset. `formatTargetLabel` owns the one spelling for that. */
	targetLabel: string | null;
	modelLabel: string | null;
	thinkingLevel: string;
	cwd: string;
	workspace: WorkspaceSnapshot | null;
	currentAvailable: boolean;
	targetHealthLabel: string | null;
	activeCapabilities: string[];
	extensions: { active: number; installed: number } | null;
	autonomy: string;
	toolProfile: string;
	compactionThreshold: string;
	clioMdStatus: string;
	hasCodewiki: boolean;
	codewikiCount: number;
	wikiPageCount: number;
	wikiStatus: string;
	wikiDigestExcerpt: string[];
	handoffCount: number;
	handoffFreshness: string;
	taskMemory: TaskMemoryOperatorStatus | null;
	/** Mirrors `WelcomeRepositoryFacts.pending`; drives the dim placeholder rows. */
	factsPending?: boolean;
}

function activeStatus(status: TargetStatus): boolean {
	return status.available && status.health.status !== "down";
}

function findCurrentStatus(
	statuses: ReadonlyArray<TargetStatus>,
	settings: Readonly<ClioSettings> | undefined,
): TargetStatus | null {
	const targetId = settings?.chat?.target ?? null;
	if (!targetId) return null;
	return statuses.find((status) => status.target.id === targetId) ?? null;
}

function capabilityLabels(caps: CapabilityFlags | null): string[] {
	if (!caps) return [];
	const out: string[] = [];
	if (caps.tools) out.push("tools");
	if (caps.reasoning) out.push("reasoning");
	if (caps.vision) out.push("vision");
	if (caps.fim) out.push("fim");
	if (caps.embeddings) out.push("embed");
	if (typeof caps.contextWindow === "number" && caps.contextWindow > 0)
		out.push(`${Math.round(caps.contextWindow / 1000)}k ctx`);
	return out.slice(0, 5);
}

function selectedModelCapabilities(
	status: TargetStatus | null,
	settings: Readonly<ClioSettings> | undefined,
	providers: ProvidersContract,
): CapabilityFlags | null {
	if (!status) return null;
	const wireModelId = settings?.chat?.model ?? status.target.defaultModel ?? null;
	const detectedReasoning =
		wireModelId && typeof providers.getDetectedReasoning === "function"
			? providers.getDetectedReasoning(status.target.id, wireModelId)
			: null;
	return resolveModelCapabilities(status, wireModelId, providers.knowledgeBase, { detectedReasoning });
}

function healthReadout(status: TargetStatus | null): string | null {
	if (!status || status.health.status === "unknown") return null;
	const latency =
		typeof status.health.latencyMs === "number" && Number.isFinite(status.health.latencyMs)
			? ` ${Math.round(status.health.latencyMs)}ms`
			: "";
	if (activeStatus(status)) return `${status.health.status}${latency}`;
	const reason = status.health.lastError ?? status.reason;
	return reason && reason !== status.health.status ? `${status.health.status}: ${reason}` : status.health.status;
}

/**
 * Extract bare entry-point paths from the codewiki digest. The digest lists
 * `- <path> (<lang>, <loc> loc): <summary>` bullets under an `entry points:`
 * header; the one-line banner row has no room for bullets, loc counts, or
 * summaries, so only the paths survive.
 */
function entryPointExcerpt(codewikiDigest: string): string[] {
	const lines = codewikiDigest.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "entry points:");
	if (start === -1) return [];
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const trimmed = line.trim();
		if (trimmed === "key symbols:" || trimmed === "dependencies:") break;
		if (!trimmed.startsWith("- ")) continue;
		const item = trimmed.slice(2);
		const parenIndex = item.indexOf(" (");
		out.push(parenIndex === -1 ? item : item.slice(0, parenIndex));
	}
	return out.slice(0, 4);
}

const NO_WIKI_STATUS = "no wiki; run clio-coder context wiki";

function clioMdStatusFor(cwd: string): string {
	const loaded = loadProjectClioMd(cwd);
	if (loaded.errors.length > 0) return "malformed";
	return loaded.files.length > 0 ? "ok" : "none";
}

/** Shape the wiki rows from a staleness verdict the caller already paid for. */
function wikiFactsFrom(cwd: string, staleness: WikiStaleness): { wikiPageCount: number; wikiStatus: string } {
	if (staleness.state === "absent") return { wikiPageCount: 0, wikiStatus: NO_WIKI_STATUS };
	const wikiPageCount = listWikiPages(cwd).length;
	const completeness = wikiCompleteness(cwd);
	const freshness =
		staleness.state === "stale"
			? `stale, ${staleness.changedFiles} changed file${staleness.changedFiles === 1 ? "" : "s"}`
			: "fresh";
	// An incomplete wiki reports what it owes even when it is current,
	// otherwise a half-finished run reads as a finished one.
	return {
		wikiPageCount,
		wikiStatus:
			completeness && completeness.owed > 0
				? `${freshness}, ${completeness.pagesWritten}/${completeness.pagesPlanned} pages`
				: freshness,
	};
}

function handoffFacts(cwd: string): { handoffCount: number; handoffFreshness: string } {
	const handoffsDir = join(cwd, ".clio-coder", "handoffs");
	if (!existsSync(handoffsDir)) return { handoffCount: 0, handoffFreshness: "none" };
	try {
		const files = readdirSync(handoffsDir).filter((f) => f.startsWith("handoff-") && f.endsWith(".md"));
		if (files.length === 0) return { handoffCount: 0, handoffFreshness: "none" };
		let newestMtime = 0;
		for (const file of files) {
			const mtime = statSync(join(handoffsDir, file)).mtimeMs;
			if (mtime > newestMtime) newestMtime = mtime;
		}
		return {
			handoffCount: files.length,
			handoffFreshness: newestMtime > 0 ? relative(newestMtime) : "none",
		};
	} catch {
		return { handoffCount: 0, handoffFreshness: "none" };
	}
}

function readWelcomeRepositoryFacts(cwd: string): WelcomeRepositoryFacts {
	const codewiki = readCodewiki(cwd);
	const wiki = codewiki ? wikiFactsFrom(cwd, wikiStaleness(cwd)) : { wikiPageCount: 0, wikiStatus: NO_WIKI_STATUS };
	return {
		clioMdStatus: clioMdStatusFor(cwd),
		hasCodewiki: codewiki !== null,
		codewikiCount: codewiki ? codewiki.files.filter((file) => file.lang !== "config").length : 0,
		...wiki,
		wikiDigestExcerpt: codewiki ? entryPointExcerpt(renderCodewikiDigest(codewiki)) : [],
		...handoffFacts(cwd),
	};
}

/**
 * The same facts without blocking a frame. The sync form costs a codewiki parse
 * of a multi-megabyte artifact plus up to four `git` subprocesses, measured at
 * 219 ms, and it used to run on the render call stack every ten seconds.
 */
async function readWelcomeRepositoryFactsAsync(cwd: string): Promise<WelcomeRepositoryFacts> {
	const codewiki = await readCodewikiAsync(cwd);
	const wiki = codewiki
		? wikiFactsFrom(cwd, await wikiStalenessAsync(cwd))
		: { wikiPageCount: 0, wikiStatus: NO_WIKI_STATUS };
	return {
		clioMdStatus: clioMdStatusFor(cwd),
		hasCodewiki: codewiki !== null,
		codewikiCount: codewiki ? codewiki.files.filter((file) => file.lang !== "config").length : 0,
		...wiki,
		wikiDigestExcerpt: codewiki ? entryPointExcerpt(renderCodewikiDigest(codewiki)) : [],
		...handoffFacts(cwd),
	};
}

/**
 * What the banner paints before the first probe returns. Everything here is one
 * `existsSync` or cheaper. `hasCodewiki` is resolved for real rather than
 * guessed, because it decides whether the Wiki row exists at all and the whole
 * point of a placeholder is that the banner never changes height.
 */
function placeholderRepositoryFacts(cwd: string): WelcomeRepositoryFacts {
	return {
		clioMdStatus: clioMdStatusFor(cwd),
		hasCodewiki: existsSync(join(cwd, ".clio-coder", "codewiki.json")),
		codewikiCount: 0,
		wikiPageCount: 0,
		wikiStatus: NO_WIKI_STATUS,
		wikiDigestExcerpt: [],
		handoffCount: 0,
		handoffFreshness: "none",
		pending: true,
	};
}

function deriveWelcomeDashboardStats(deps: WelcomeDashboardDeps): WelcomeDashboardStats {
	const settings = deps.getSettings?.();
	const statuses = deps.providers.list();
	const current = findCurrentStatus(statuses, settings);
	// Left null when unset; formatTargetLabel owns the one spelling for that.
	const targetLabel = current?.target.id ?? settings?.chat?.target ?? null;
	const modelLabel = settings?.chat?.model ?? current?.target.defaultModel ?? null;
	const workspace = deps.getWorkspaceSnapshot?.() ?? null;
	const cwd = workspace?.cwd ?? process.cwd();
	const currentAvailable = current ? activeStatus(current) : false;
	const activeCapabilities = capabilityLabels(selectedModelCapabilities(current, settings, deps.providers));
	const thinkingLevel =
		resolveModelRuntimeCapabilitiesForProviders(
			deps.providers,
			settings?.chat?.target,
			settings?.chat?.model,
			settings?.chat?.thinkingLevel ?? "off",
		)?.thinking.display ??
		settings?.chat?.thinkingLevel ??
		"off";

	const autonomy = settings?.safety.autonomy ?? "auto-edit";
	const toolProfile = settings?.integrations.externalAgents?.defaults?.toolGovernance ?? "clio-policy";
	const threshold = settings?.context.compaction?.threshold;
	const compactionThreshold =
		typeof threshold === "number" && Number.isFinite(threshold) ? `${Math.round(threshold * 100)}%` : "80%";

	const {
		clioMdStatus,
		hasCodewiki,
		codewikiCount,
		wikiPageCount,
		wikiStatus,
		wikiDigestExcerpt,
		handoffCount,
		handoffFreshness,
		pending,
	} = (deps.readRepositoryFacts ?? readWelcomeRepositoryFacts)(cwd);

	return {
		activeTargets: statuses.filter(activeStatus).length,
		totalTargets: statuses.length,
		targetLabel,
		modelLabel,
		thinkingLevel,
		cwd,
		workspace,
		currentAvailable,
		targetHealthLabel: healthReadout(current),
		activeCapabilities,
		extensions: deps.getExtensionStats?.() ?? null,
		autonomy,
		toolProfile,
		compactionThreshold,
		clioMdStatus,
		hasCodewiki,
		codewikiCount,
		wikiPageCount,
		wikiStatus,
		wikiDigestExcerpt,
		handoffCount,
		handoffFreshness,
		taskMemory: deps.getTaskMemoryStatus?.() ?? null,
		...(pending ? { factsPending: true } : {}),
	};
}

const MID_MIN = 64;

export type WelcomeDashboardMode = "launchpad" | "session";

export interface WelcomeDashboardComponent extends Component {
	collapseToSessionHeader(): boolean;
	resetToLaunchpad(): boolean;
}

function workspaceValue(stats: WelcomeDashboardStats): string {
	const workspace = stats.workspace;
	const location = basename(stats.cwd) || stats.cwd;
	if (!workspace) return location;
	const branch = workspace.branch ? ` · git ${workspace.branch}${workspace.dirty ? "*" : ""}` : "";
	return `${location}${branch}`;
}

function routeValue(stats: WelcomeDashboardStats): string {
	const target = formatTargetLabel(stats.targetLabel, stats.modelLabel);
	if (stats.currentAvailable) {
		const health = stats.targetHealthLabel ? ` · ${stats.targetHealthLabel}` : "";
		return `${target} · ready${health}`;
	}
	return `${target} · unavailable`;
}

function nextValue(stats: WelcomeDashboardStats): string {
	if (stats.factsPending === true) return `ctx checking ${GLYPH.ellipsis}`;
	if (stats.clioMdStatus !== "ok") return "ctx missing · /context init";
	return "ctx ready · type a task";
}

/**
 * The launchpad has one fixed row per decision the operator needs to make.
 * Repository facts may replace text inside NEXT, never rows. After submission,
 * the session header is exactly one line for every width and fact state, and
 * it carries the same three facts in order: where Clio is working, which
 * route answers, and what the context is ready for. Maturity caveats belong
 * in the README, not in a line the operator reads on every turn.
 */
function buildWelcomeDashboardLines(
	stats: WelcomeDashboardStats,
	width: number,
	mode: WelcomeDashboardMode = "launchpad",
): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
	const title = `${brandMark(theme)} ${theme.style("title", "Clio Coder", { bold: true })} ${theme.fg("dim", `v${readClioVersion()}`)}`;
	const tag = (label: string): string => sectionTag(theme, "accentDeep", label, 9);
	const row = (label: string, value: string): string => `  ${tag(label)}  ${value}`;
	const workspace = theme.fg("muted", workspaceValue(stats));
	const route = theme.fg(stats.currentAvailable ? "success" : "warning", routeValue(stats));
	const next = theme.fg(stats.clioMdStatus === "ok" && !stats.factsPending ? "success" : "warning", nextValue(stats));

	if (mode === "session") {
		const header = [title, workspace, route, theme.fg("muted", nextValue(stats))].join(" · ");
		return [truncateToWidth(header, safeWidth, GLYPH.ellipsis, true)];
	}

	const body = [row("WORKSPACE", workspace), row("ROUTE", route), row("NEXT", next)];
	if (safeWidth >= MID_MIN) return frame(theme, title, body, safeWidth);
	return [title, ...body].map((line) => truncateToWidth(line, safeWidth, GLYPH.ellipsis, true));
}

/**
 * How long a repository probe is trusted. The probe costs three `git`
 * subprocesses, a codewiki parse, and a workspace walk, and the render timer
 * asks for a frame every 16ms; at that rate an uncached banner spent 38% of the
 * process's CPU re-reading facts that had not changed, on the same event loop
 * that decodes the model stream. Ten seconds is far longer than a frame and far
 * shorter than a person's patience for a stale `changed files` count, and any
 * command that can actually change these facts drops the cache outright.
 */
export const WELCOME_REPOSITORY_FACTS_TTL_MS = 10_000;

/**
 * Everything in `WelcomeDashboardStats` that can change what the banner prints,
 * flattened to one comparable string. Cheap enough to build per frame; the
 * alternative was rebuilding seven framed rows, which cost 1.67 ms/frame and was
 * 94% of all time spent inside the root container's render.
 */
function statsSignature(stats: WelcomeDashboardStats): string {
	const w = stats.workspace;
	return [
		stats.activeTargets,
		stats.totalTargets,
		stats.targetLabel,
		stats.modelLabel,
		stats.thinkingLevel,
		stats.cwd,
		w && `${w.branch}\x01${w.dirty}\x01${w.projectType}\x01${w.isGit}\x01${w.remoteUrl}`,
		stats.currentAvailable,
		stats.targetHealthLabel,
		stats.activeCapabilities.join(","),
		stats.extensions && `${stats.extensions.active}/${stats.extensions.installed}`,
		stats.autonomy,
		stats.toolProfile,
		stats.compactionThreshold,
		stats.clioMdStatus,
		stats.hasCodewiki,
		stats.codewikiCount,
		stats.wikiPageCount,
		stats.wikiStatus,
		stats.wikiDigestExcerpt.join(","),
		stats.handoffCount,
		stats.handoffFreshness,
		stats.taskMemory && `${stats.taskMemory.enabled}\x01${stats.taskMemory.tier}\x01${stats.taskMemory.size}`,
		stats.factsPending === true,
	].join("\0");
}

export class WelcomeDashboard implements WelcomeDashboardComponent {
	private cachedFacts: { cwd: string; at: number; facts: WelcomeRepositoryFacts } | null = null;
	private cachedRender: { width: number; signature: string; lines: string[] } | null = null;
	/** Single-flight latch: a probe slower than the TTL must not stack refreshes. */
	private refreshing = false;
	private mode: WelcomeDashboardMode = "launchpad";

	constructor(
		private readonly deps: WelcomeDashboardDeps,
		private readonly now: () => number = () => Date.now(),
	) {}

	render(width: number): string[] {
		const stats = deriveWelcomeDashboardStats({ ...this.deps, readRepositoryFacts: (cwd) => this.facts(cwd) });
		const signature = `${this.mode}\0${statsSignature(stats)}`;
		const cached = this.cachedRender;
		if (cached !== null && cached.width === width && cached.signature === signature) return cached.lines;
		const lines = buildWelcomeDashboardLines(stats, width, this.mode);
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

	/** Drops the repository probe and the rendered lines so the next frame re-reads both. */
	invalidate(): void {
		this.cachedFacts = null;
		this.cachedRender = null;
	}

	/**
	 * Returns immediately, always. On a miss it hands back a placeholder (or the
	 * last known reading) and schedules the real probe off the render path. The
	 * probe used to run here, synchronously, inside `Container.render`.
	 */
	private facts(cwd: string): WelcomeRepositoryFacts {
		const at = this.now();
		const cached = this.cachedFacts;
		// A changed cwd is a different repository, not a stale reading of this one.
		const usable = cached !== null && cached.cwd === cwd;
		if (usable && at - cached.at < WELCOME_REPOSITORY_FACTS_TTL_MS) return cached.facts;
		// A test-injected probe is synchronous by contract and cheap by construction.
		const override = this.deps.readRepositoryFacts;
		if (override) {
			const facts = override(cwd);
			this.cachedFacts = { cwd, at, facts };
			return facts;
		}
		this.scheduleFactsRefresh(cwd);
		return usable ? cached.facts : placeholderRepositoryFacts(cwd);
	}

	private scheduleFactsRefresh(cwd: string): void {
		if (this.refreshing) return;
		this.refreshing = true;
		void readWelcomeRepositoryFactsAsync(cwd)
			.then((facts) => {
				this.cachedFacts = { cwd, at: this.now(), facts };
				this.cachedRender = null;
				this.deps.onFactsRefreshed?.();
			})
			.catch(() => {
				// A failed probe leaves the last known facts in place and retries on the
				// next frame past the TTL; the banner is not worth surfacing an error for.
			})
			.finally(() => {
				this.refreshing = false;
			});
	}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): WelcomeDashboard {
	return new WelcomeDashboard(deps);
}
