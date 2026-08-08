import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { readClioVersion, resolvePackageRoot } from "../core/package-root.js";
import {
	listWikiPages,
	readCodewiki,
	renderCodewikiDigest,
	wikiCompleteness,
	wikiStaleness,
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
import { abbreviateModelId, brandMark, type ClioTheme, clioTheme, fitUnits, frame } from "./theme/index.js";

export interface WelcomeDashboardDeps {
	providers: ProvidersContract;
	observability: ObservabilityContract;
	getContextUsage?: () => ContextUsageSnapshot;
	getSettings?: () => Readonly<ClioSettings>;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	getExtensionStats?: () => { active: number; installed: number };
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
}

export interface WelcomeDashboardStats {
	activeTargets: number;
	totalTargets: number;
	targetLabel: string;
	modelLabel: string;
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

function _contextCapability(labels: ReadonlyArray<string>): string {
	return labels.find((label) => label.endsWith(" ctx")) ?? "ctx unknown";
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

export function deriveWelcomeDashboardStats(deps: WelcomeDashboardDeps): WelcomeDashboardStats {
	const settings = deps.getSettings?.();
	const statuses = deps.providers.list();
	const current = findCurrentStatus(statuses, settings);
	const targetLabel = current?.target.id ?? settings?.orchestrator?.target ?? "not configured";
	const modelLabel = settings?.orchestrator?.model ?? current?.target.defaultModel ?? "not configured";
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

	let clioMdStatus = "none";
	let hasCodewiki = false;
	let codewikiCount = 0;
	let wikiPageCount = 0;
	let wikiStatus = "no wiki; run clio context wiki";
	let wikiDigestExcerpt: string[] = [];
	let handoffCount = 0;
	let handoffFreshness = "none";

	const clioMdPath = join(cwd, "CLIO.md");
	if (existsSync(clioMdPath)) {
		clioMdStatus = "ok";
	}

	const codewiki = readCodewiki(cwd);
	if (codewiki) {
		hasCodewiki = true;
		codewikiCount = codewiki.files.filter((file) => file.lang !== "config").length;
		wikiDigestExcerpt = entryPointExcerpt(renderCodewikiDigest(codewiki));
		const staleness = wikiStaleness(cwd);
		if (staleness.state !== "absent") {
			wikiPageCount = listWikiPages(cwd).length;
			const completeness = wikiCompleteness(cwd);
			const freshness =
				staleness.state === "stale"
					? `stale, ${staleness.changedFiles} changed file${staleness.changedFiles === 1 ? "" : "s"}`
					: "fresh";
			// An incomplete wiki reports what it owes even when it is current,
			// otherwise a half-finished run reads as a finished one.
			wikiStatus =
				completeness && completeness.owed > 0
					? `${freshness}, ${completeness.pagesWritten}/${completeness.pagesPlanned} pages`
					: freshness;
		}
	}

	const handoffsDir = join(cwd, ".clio", "handoffs");
	if (existsSync(handoffsDir)) {
		try {
			const files = readdirSync(handoffsDir).filter((f) => f.startsWith("handoff-") && f.endsWith(".md"));
			handoffCount = files.length;
			if (files.length > 0) {
				let newestMtime = 0;
				for (const file of files) {
					const mtime = statSync(join(handoffsDir, file)).mtimeMs;
					if (mtime > newestMtime) newestMtime = mtime;
				}
				if (newestMtime > 0) {
					handoffFreshness = formatRelativeTime(newestMtime);
				}
			}
		} catch {
			// Ignore
		}
	}

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
	};
}

const WIDE_MIN = 90;
const MID_MIN = 64;
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

	// The whole styled title (logotype, bold name, dim version) is handed to
	// the canonical island frame, which places it with one space on each side.
	const title = `${brandMark(theme)} ${theme.style("title", "Clio Coder", { bold: true })} ${theme.fg("dim", `v${readClioVersion()}`)}`;

	const targetVal = `${theme.fg("accent", stats.targetLabel)}/${abbreviateModelId(stats.modelLabel)}`;
	const thinkVal = `think ${theme.fg("reason", stats.thinkingLevel)}`;

	let clioMdStr = `CLIO.md ${stats.clioMdStatus}`;
	if (stats.clioMdStatus === "ok") {
		clioMdStr = `${theme.fg("success", "CLIO.md ok")}`;
	} else if (stats.clioMdStatus === "stale") {
		clioMdStr = `${theme.fg("warning", "CLIO.md stale")}`;
	} else {
		clioMdStr = `${theme.fg("dim", "CLIO.md none")}`;
	}

	const codewikiStr =
		stats.codewikiCount > 0
			? `${theme.fg("info", `${stats.codewikiCount} modules`)}`
			: `${theme.fg("dim", "no codewiki")}`;

	const handoffStr =
		stats.handoffCount > 0
			? `${theme.fg("muted", `handoff ${stats.handoffFreshness}`)}`
			: `${theme.fg("dim", "no handoff")}`;

	const safetyStr = `autonomy ${theme.fg("accentDeep", stats.autonomy)}`;
	const profileStr = `profile ${theme.fg("dim", stats.toolProfile)}`;
	const compactStr = `compact @${theme.fg("muted", stats.compactionThreshold)}`;
	const wikiStateStr =
		stats.wikiStatus === "no wiki; run clio context wiki"
			? theme.fg("dim", stats.wikiStatus)
			: `${theme.fg("info", `${stats.wikiPageCount} page${stats.wikiPageCount === 1 ? "" : "s"}`)} · ${theme.fg(
					stats.wikiStatus === "fresh" ? "success" : "warning",
					stats.wikiStatus,
				)}`;
	const wikiUnits = [
		wikiStateStr,
		...(stats.wikiDigestExcerpt.length > 0
			? stats.wikiDigestExcerpt.map((path, index) => theme.fg("muted", index === 0 ? `entry points: ${path}` : path))
			: [theme.fg("muted", "entry points: none")]),
	];

	const hintUnits = [
		`Type ${theme.fg("accent", "/settings")} to edit`,
		`${theme.fg("accent", "/context init")} to bootstrap`,
		`${theme.fg("accent", "Alt+U")} to toggle dashboard`,
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
		const healthStr = stats.targetHealthLabel ? ` · health: ${theme.fg("success", stats.targetHealthLabel)}` : "";
		const targetLine = `  ${theme.fg("muted", "Target:")}   ${targetVal} · ${thinkVal}${healthStr}`;
		const contextLine = `  ${theme.fg("muted", "Context:")}  ${clioMdStr} · ${codewikiStr} · ${handoffStr}`;
		const wikiLine = fitUnits(theme, `  ${theme.fg("muted", "Wiki:")}     `, wikiUnits, contentWidth);
		const settingsLine = `  ${theme.fg("muted", "Config:")}   ${safetyStr} · ${profileStr} · ${compactStr}`;
		const memoryLine = fitUnits(theme, `  ${theme.fg("muted", "Memory:")}   `, memoryUnits, contentWidth);
		const hintLine = fitUnits(theme, `  ${theme.fg("muted", "Hint:")}     `, hintUnits, contentWidth);

		return frame(
			theme,
			title,
			[
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
		const targetLine = `  ${theme.fg("muted", "Target:")}  ${targetVal} · ${thinkVal}`;
		const contextLine = `  ${theme.fg("muted", "Context:")} ${clioMdStr} · ${codewikiStr} · ${handoffStr}`;
		const wikiLine = fitUnits(theme, `  ${theme.fg("muted", "Wiki:")}    `, wikiUnits, contentWidth);
		const configLine = `  ${theme.fg("muted", "Config:")}  ${safetyStr} · ${profileStr}`;
		const memoryLine = fitUnits(theme, `  ${theme.fg("muted", "Memory:")}  `, memoryUnits, contentWidth);
		const hintLine = fitUnits(theme, `  ${theme.fg("muted", "Hint:")}    `, hintUnits, contentWidth);

		return frame(
			theme,
			title,
			[
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
			`  ${targetVal} · ${thinkVal}`,
			`  ${clioMdStr} · ${codewikiStr}`,
			...(stats.hasCodewiki ? [`  wiki ${stats.wikiStatus}`] : []),
			`  ${safetyStr} · ${theme.fg("accent", "Alt+U")} toggle`,
			...(memoryUnits.length > 0 ? [fitUnits(theme, "  Memory: ", memoryUnits, safeWidth)] : []),
		].map((line) => truncateToWidth(line, safeWidth, "", true));
	}
}

export class WelcomeDashboard implements Component {
	private readonly logo: Component | null;

	constructor(private readonly deps: WelcomeDashboardDeps) {
		this.logo = createLogoImage(clioTheme());
	}

	render(width: number): string[] {
		const lines = buildWelcomeDashboardLines(deriveWelcomeDashboardStats(this.deps), width);
		if (width < WIDE_MIN || !getCapabilities().images || !this.logo) return lines;
		return [...this.logo.render(width), ...lines];
	}

	invalidate(): void {}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): Component {
	return new WelcomeDashboard(deps);
}
