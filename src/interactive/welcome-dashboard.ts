import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { readClioVersion, resolvePackageRoot } from "../core/package-root.js";
import { EXPERIMENTAL_RELEASE_WARNING } from "../core/release.js";
import {
	listWikiPages,
	readCodewiki,
	readCodewikiAsync,
	renderCodewikiDigest,
	type WikiStaleness,
	wikiCompleteness,
	wikiStaleness,
	wikiStalenessAsync,
} from "../domains/context/index.js";
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
import { type Component, getCapabilities, Image, type ImageTheme, truncateToWidth } from "../engine/tui.js";
import { brandMark, type ClioTheme, clioTheme, fitUnits, formatTargetLabel, frame, GLYPH } from "./theme/index.js";

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
	const targetId = settings?.orchestrator?.target ?? null;
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
	const wireModelId = settings?.orchestrator?.model ?? status.target.defaultModel ?? null;
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

function formatRelativeTime(mtimeMs: number, now = Date.now()): string {
	const diffMs = now - mtimeMs;
	if (diffMs < 0) return "just now";
	const sec = Math.floor(diffMs / 1000);
	if (sec < 5) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day === 1) return "yesterday";
	if (day < 7) return `${day}d ago`;
	return new Date(mtimeMs).toISOString().slice(0, 10);
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
	return existsSync(join(cwd, "CLIO-CODER.md")) ? "ok" : "none";
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
			handoffFreshness: newestMtime > 0 ? formatRelativeTime(newestMtime) : "none",
		};
	} catch {
		return { handoffCount: 0, handoffFreshness: "none" };
	}
}

export function readWelcomeRepositoryFacts(cwd: string): WelcomeRepositoryFacts {
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
export function placeholderRepositoryFacts(cwd: string): WelcomeRepositoryFacts {
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

export function deriveWelcomeDashboardStats(deps: WelcomeDashboardDeps): WelcomeDashboardStats {
	const settings = deps.getSettings?.();
	const statuses = deps.providers.list();
	const current = findCurrentStatus(statuses, settings);
	// Left null when unset; formatTargetLabel owns the one spelling for that.
	const targetLabel = current?.target.id ?? settings?.orchestrator?.target ?? null;
	const modelLabel = settings?.orchestrator?.model ?? current?.target.defaultModel ?? null;
	const workspace = deps.getWorkspaceSnapshot?.() ?? null;
	const cwd = workspace?.cwd ?? process.cwd();
	const currentAvailable = current ? activeStatus(current) : false;
	const activeCapabilities = capabilityLabels(selectedModelCapabilities(current, settings, deps.providers));
	const thinkingLevel =
		resolveModelRuntimeCapabilitiesForProviders(
			deps.providers,
			settings?.orchestrator?.target,
			settings?.orchestrator?.model,
			settings?.orchestrator?.thinkingLevel ?? "off",
		)?.thinking.display ??
		settings?.orchestrator?.thinkingLevel ??
		"off";

	const autonomy = settings?.autonomy ?? "auto-edit";
	const toolProfile = settings?.delegation?.defaults?.toolGovernance ?? "clio-policy";
	const threshold = settings?.compaction?.threshold;
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

const WIDE_MIN = 90;
const MID_MIN = 64;
/** Widest banner key (`Context`, `Memory`), so every value starts in one column. */
const WELCOME_KEY_WIDTH = 7;
const LOGO_ASSET_PATH = "assets/clio-coder-logo-128.webp";

let cachedLogoBase64: string | null | undefined;

function clioLogoBase64(): string | null {
	if (cachedLogoBase64 !== undefined) return cachedLogoBase64;
	const path = join(resolvePackageRoot(), LOGO_ASSET_PATH);
	if (!existsSync(path)) {
		cachedLogoBase64 = null;
		return cachedLogoBase64;
	}
	cachedLogoBase64 = readFileSync(path).toString("base64");
	return cachedLogoBase64;
}

function createLogoImage(theme: ClioTheme): Component | null {
	const base64 = clioLogoBase64();
	if (!base64) return null;
	const imageTheme: ImageTheme = {
		fallbackColor: (text) => theme.fg("dim", text),
	};
	return new Image(base64, "image/webp", imageTheme, {
		filename: "clio-coder-logo-128.webp",
		maxWidthCells: 8,
		maxHeightCells: 4,
	});
}

export function buildWelcomeDashboardLines(stats: WelcomeDashboardStats, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
	const contentWidth = safeWidth - 4;

	/**
	 * Section 2.4: a key-value key is dim, bare of punctuation, and padded to one
	 * column width so every value starts in the same place. These labels used to
	 * carry a colon and the `muted` body token, which put them in the same voice
	 * as the values they introduce and made each row's alignment a hand-counted
	 * run of spaces.
	 */
	const kvKey = (label: string): string => `  ${theme.fg("dim", label.padEnd(WELCOME_KEY_WIDTH))}  `;

	// The whole styled title (logotype, bold name, dim version) is handed to
	// the canonical island frame, which places it with one space on each side.
	const title = `${brandMark(theme)} ${theme.style("title", "Clio Coder", { bold: true })} ${theme.fg("dim", `v${readClioVersion()}`)}`;
	const experimentalLine = `  ${theme.style("warning", EXPERIMENTAL_RELEASE_WARNING, { bold: true })}`;

	const targetVal = theme.fg("accent", formatTargetLabel(stats.targetLabel, stats.modelLabel));
	const thinkVal = `think ${theme.fg("reason", stats.thinkingLevel)}`;

	let clioMdStr = `CLIO-CODER.md ${stats.clioMdStatus}`;
	if (stats.clioMdStatus === "ok") {
		clioMdStr = `${theme.fg("success", "CLIO-CODER.md ok")}`;
	} else if (stats.clioMdStatus === "stale") {
		clioMdStr = `${theme.fg("warning", "CLIO-CODER.md stale")}`;
	} else {
		clioMdStr = `${theme.fg("dim", "CLIO-CODER.md none")}`;
	}

	// While the probe is in flight these rows say "reading", not "none": a dim
	// placeholder is honest about not knowing yet, where "no codewiki" would be a
	// wrong answer that corrects itself a moment later.
	const pending = stats.factsPending === true;
	const placeholder = (label: string): string => theme.fg("dim", `${label} ${GLYPH.ellipsis}`);

	const codewikiStr = pending
		? placeholder("codewiki")
		: stats.codewikiCount > 0
			? `${theme.fg("info", `${stats.codewikiCount} modules`)}`
			: `${theme.fg("dim", "no codewiki")}`;

	const handoffStr = pending
		? placeholder("handoff")
		: stats.handoffCount > 0
			? `${theme.fg("muted", `handoff ${stats.handoffFreshness}`)}`
			: `${theme.fg("dim", "no handoff")}`;

	const safetyStr = `autonomy ${theme.fg("accentDeep", stats.autonomy)}`;
	const profileStr = `profile ${theme.fg("dim", stats.toolProfile)}`;
	const compactStr = `compact @${theme.fg("muted", stats.compactionThreshold)}`;
	const wikiStateStr = pending
		? placeholder("wiki")
		: stats.wikiStatus === NO_WIKI_STATUS
			? theme.fg("dim", stats.wikiStatus)
			: `${theme.fg("info", `${stats.wikiPageCount} page${stats.wikiPageCount === 1 ? "" : "s"}`)} · ${theme.fg(
					stats.wikiStatus === "fresh" ? "success" : "warning",
					stats.wikiStatus,
				)}`;
	const wikiUnits = pending
		? [wikiStateStr, theme.fg("dim", `entry points ${GLYPH.ellipsis}`)]
		: [
				wikiStateStr,
				...(stats.wikiDigestExcerpt.length > 0
					? stats.wikiDigestExcerpt.map((path, index) => theme.fg("muted", index === 0 ? `entry points: ${path}` : path))
					: [theme.fg("muted", "entry points: none")]),
			];

	// Section 2.5 grammar: an affordance is `[Key] verb`, the same shape the
	// overlay footers use, so the banner teaches the vocabulary the rest of the
	// TUI speaks. These used to be prose ("Type /settings to edit").
	const hintKey = (key: string): string => theme.fg("dim", `[${key}]`);
	const hintUnits = [
		`${hintKey("type")} ${theme.fg("accent", "/settings")} ${theme.fg("muted", "to configure")}`,
		`${hintKey("type")} ${theme.fg("accent", "/context init")} ${theme.fg("muted", "to bootstrap")}`,
		`${hintKey("Alt+U")} ${theme.fg("muted", "toggle dashboard")}`,
	];
	const memoryUnits = stats.taskMemory
		? [
				theme.fg(stats.taskMemory.enabled ? "success" : "dim", stats.taskMemory.enabled ? "on" : "off"),
				theme.fg(
					stats.taskMemory.tier === "llm" ? "reason" : "muted",
					`tier ${stats.taskMemory.tier === "llm" ? "LLM" : "rules"}`,
				),
				theme.fg("muted", `bank ${stats.taskMemory.size}`),
			]
		: [];

	// The wiki and hint rows are the lines long enough to overflow. fitUnits
	// drops whole ` · `-separated units and closes with a dim ellipsis instead of
	// cutting a path or phrase mid-glyph, so a truncated row still reads as facts.
	if (safeWidth >= WIDE_MIN) {
		const healthStr = stats.targetHealthLabel ? ` · health ${theme.fg("success", stats.targetHealthLabel)}` : "";
		const targetLine = `${kvKey("Target")}${targetVal} · ${thinkVal}${healthStr}`;
		const contextLine = `${kvKey("Context")}${clioMdStr} · ${codewikiStr} · ${handoffStr}`;
		const wikiLine = fitUnits(theme, kvKey("Wiki"), wikiUnits, contentWidth);
		const settingsLine = `${kvKey("Config")}${safetyStr} · ${profileStr} · ${compactStr}`;
		const memoryLine = fitUnits(theme, kvKey("Memory"), memoryUnits, contentWidth);
		const hintLine = fitUnits(theme, kvKey("Hint"), hintUnits, contentWidth);

		return frame(
			theme,
			title,
			[
				experimentalLine,
				targetLine,
				contextLine,
				...(stats.hasCodewiki ? [wikiLine] : []),
				settingsLine,
				...(memoryUnits.length > 0 ? [memoryLine] : []),
				hintLine,
			],
			safeWidth,
		);
	} else if (safeWidth >= MID_MIN) {
		const targetLine = `${kvKey("Target")}${targetVal} · ${thinkVal}`;
		const contextLine = `${kvKey("Context")}${clioMdStr} · ${codewikiStr} · ${handoffStr}`;
		const wikiLine = fitUnits(theme, kvKey("Wiki"), wikiUnits, contentWidth);
		const configLine = `${kvKey("Config")}${safetyStr} · ${profileStr}`;
		const memoryLine = fitUnits(theme, kvKey("Memory"), memoryUnits, contentWidth);
		const hintLine = fitUnits(theme, kvKey("Hint"), hintUnits, contentWidth);

		return frame(
			theme,
			title,
			[
				experimentalLine,
				targetLine,
				contextLine,
				...(stats.hasCodewiki ? [wikiLine] : []),
				configLine,
				...(memoryUnits.length > 0 ? [memoryLine] : []),
				hintLine,
			],
			safeWidth,
		);
	} else {
		return [
			title,
			`  ${theme.style("warning", "EXPERIMENTAL", { bold: true })}`,
			`  ${theme.fg("warning", "May break or change.")}`,
			`  ${targetVal} · ${thinkVal}`,
			`  ${clioMdStr} · ${codewikiStr}`,
			...(stats.hasCodewiki ? [`  wiki ${pending ? GLYPH.ellipsis : stats.wikiStatus}`] : []),
			`  ${safetyStr} · ${hintKey("Alt+U")} ${theme.fg("muted", "toggle")}`,
			...(memoryUnits.length > 0 ? [fitUnits(theme, kvKey("Memory"), memoryUnits, safeWidth)] : []),
			// A cut with no marker presents the fragment as the whole value, which is
			// the rule the 40/80/120 sweep was written against.
		].map((line) => truncateToWidth(line, safeWidth, GLYPH.ellipsis, true));
	}
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

export class WelcomeDashboard implements Component {
	private readonly logo: Component | null;
	private cachedFacts: { cwd: string; at: number; facts: WelcomeRepositoryFacts } | null = null;
	private cachedRender: { width: number; signature: string; lines: string[] } | null = null;
	/** Single-flight latch: a probe slower than the TTL must not stack refreshes. */
	private refreshing = false;

	constructor(
		private readonly deps: WelcomeDashboardDeps,
		private readonly now: () => number = () => Date.now(),
	) {
		this.logo = createLogoImage(clioTheme());
	}

	render(width: number): string[] {
		const stats = deriveWelcomeDashboardStats({ ...this.deps, readRepositoryFacts: (cwd) => this.facts(cwd) });
		const signature = statsSignature(stats);
		const cached = this.cachedRender;
		if (cached !== null && cached.width === width && cached.signature === signature) return cached.lines;
		const body = buildWelcomeDashboardLines(stats, width);
		const lines =
			width < WIDE_MIN || !getCapabilities().images || !this.logo ? body : [...this.logo.render(width), ...body];
		this.cachedRender = { width, signature, lines };
		return lines;
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

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): Component {
	return new WelcomeDashboard(deps);
}
