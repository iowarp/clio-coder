import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { readClioVersion, resolvePackageRoot } from "../core/package-root.js";
import { readCodewiki } from "../domains/context/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import {
	type CapabilityFlags,
	type EndpointStatus,
	type ProvidersContract,
	resolveModelCapabilities,
	resolveModelRuntimeCapabilitiesForProviders,
} from "../domains/providers/index.js";
import type { ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import {
	type Component,
	getCapabilities,
	Image,
	type ImageTheme,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { abbreviateModelId, type ClioTheme, clioTheme, GLYPH } from "./theme/index.js";

export interface WelcomeDashboardDeps {
	providers: ProvidersContract;
	observability: ObservabilityContract;
	getContextUsage?: () => ContextUsageSnapshot;
	getSettings?: () => Readonly<ClioSettings>;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	getExtensionStats?: () => { active: number; installed: number };
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
	safetyLevel: string;
	toolProfile: string;
	compactionThreshold: string;
	clioMdStatus: string;
	codewikiCount: number;
	handoffCount: number;
	handoffFreshness: string;
}

function stripAnsi(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 27 && text[i + 1] === "[") {
			i += 2;
			while (i < text.length && text[i] !== "m") i += 1;
			continue;
		}
		out += text[i] ?? "";
	}
	return out;
}

function activeStatus(status: EndpointStatus): boolean {
	return status.available && status.health.status !== "down";
}

function findCurrentStatus(
	statuses: ReadonlyArray<EndpointStatus>,
	settings: Readonly<ClioSettings> | undefined,
): EndpointStatus | null {
	const endpointId = settings?.orchestrator?.endpoint ?? null;
	if (!endpointId) return null;
	return statuses.find((status) => status.endpoint.id === endpointId) ?? null;
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
	status: EndpointStatus | null,
	settings: Readonly<ClioSettings> | undefined,
	providers: ProvidersContract,
): CapabilityFlags | null {
	if (!status) return null;
	const wireModelId = settings?.orchestrator?.model ?? status.endpoint.defaultModel ?? null;
	const detectedReasoning =
		wireModelId && typeof providers.getDetectedReasoning === "function"
			? providers.getDetectedReasoning(status.endpoint.id, wireModelId)
			: null;
	return resolveModelCapabilities(status, wireModelId, providers.knowledgeBase, { detectedReasoning });
}

function healthReadout(status: EndpointStatus | null): string | null {
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

export function deriveWelcomeDashboardStats(deps: WelcomeDashboardDeps): WelcomeDashboardStats {
	const settings = deps.getSettings?.();
	const statuses = deps.providers.list();
	const current = findCurrentStatus(statuses, settings);
	const targetLabel = current?.endpoint.id ?? settings?.orchestrator?.endpoint ?? "not configured";
	const modelLabel = settings?.orchestrator?.model ?? current?.endpoint.defaultModel ?? "not configured";
	const workspace = deps.getWorkspaceSnapshot?.() ?? null;
	const cwd = workspace?.cwd ?? process.cwd();
	const currentAvailable = current ? activeStatus(current) : false;
	const activeCapabilities = capabilityLabels(selectedModelCapabilities(current, settings, deps.providers));
	const thinkingLevel =
		resolveModelRuntimeCapabilitiesForProviders(
			deps.providers,
			settings?.orchestrator?.endpoint,
			settings?.orchestrator?.model,
			settings?.orchestrator?.thinkingLevel ?? "off",
		)?.thinking.display ??
		settings?.orchestrator?.thinkingLevel ??
		"off";

	const safetyLevel = settings?.safetyLevel ?? "auto-edit";
	const toolProfile = settings?.delegation?.defaults?.toolGovernance ?? "clio-policy";
	const compactionThreshold = settings?.compaction?.threshold
		? `${Math.round(settings.compaction.threshold * 100)}%`
		: "80%";

	let clioMdStatus = "none";
	let codewikiCount = 0;
	let handoffCount = 0;
	let handoffFreshness = "none";

	const clioMdPath = join(cwd, "CLIO.md");
	if (existsSync(clioMdPath)) {
		clioMdStatus = "ok";
	}

	const codewiki = readCodewiki(cwd);
	if (codewiki) {
		codewikiCount = codewiki.entries.length;
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
		safetyLevel,
		toolProfile,
		compactionThreshold,
		clioMdStatus,
		codewikiCount,
		handoffCount,
		handoffFreshness,
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

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

// Draw the top border so the panel is exactly `safeWidth` columns wide
// regardless of the rendered title. The title carries ANSI styling and a
// variable-width version suffix, so the fill is derived from the title's
// visible width rather than a hardcoded reference string.
function framedTopBorder(title: string, safeWidth: number, theme: ClioTheme): string {
	const prefix = "┌── ";
	const suffix = "──┐";
	const fill = Math.max(0, safeWidth - visibleWidth(prefix) - visibleWidth(title) - visibleWidth(suffix));
	return `${theme.fg("frame", prefix)}${title}${theme.fg("frame", "─".repeat(fill))}${theme.fg("frame", suffix)}`;
}

function framedBottomBorder(safeWidth: number, theme: ClioTheme): string {
	return `${theme.fg("frame", "└")}${theme.fg("frame", "─".repeat(Math.max(0, safeWidth - 2)))}${theme.fg("frame", "┘")}`;
}

export function buildWelcomeDashboardLines(stats: WelcomeDashboardStats, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);

	const title = `${theme.fg("frame", GLYPH.agent)} ${theme.style("title", "Clio Coder", { bold: true })} ${theme.fg("dim", `v${readClioVersion()}`)}`;

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

	const safetyStr = `safety ${theme.fg("accentDeep", stats.safetyLevel)}`;
	const profileStr = `profile ${theme.fg("dim", stats.toolProfile)}`;
	const compactStr = `compact @${theme.fg("muted", stats.compactionThreshold)}`;

	const hintStr = `Type ${theme.fg("accent", "/settings")} to edit · ${theme.fg("accent", "/context-init")} to bootstrap · ${theme.fg("accent", "Alt+U")} to toggle dashboard`;

	if (safeWidth >= WIDE_MIN) {
		const healthStr = stats.targetHealthLabel ? ` · health: ${theme.fg("success", stats.targetHealthLabel)}` : "";
		const targetLine = `  ${theme.fg("muted", "Target:")}   ${targetVal} · ${thinkVal}${healthStr}`;
		const contextLine = `  ${theme.fg("muted", "Context:")}  ${clioMdStr} · ${codewikiStr} · ${handoffStr}`;
		const settingsLine = `  ${theme.fg("muted", "Config:")}   ${safetyStr} · ${profileStr} · ${compactStr}`;
		const hintLine = `  ${theme.fg("muted", "Hint:")}     ${hintStr}`;

		const innerWidth = safeWidth - 4;
		const body = [
			`${theme.fg("frame", "│")} ${padAnsi(targetLine, innerWidth)} ${theme.fg("frame", "│")}`,
			`${theme.fg("frame", "│")} ${padAnsi(contextLine, innerWidth)} ${theme.fg("frame", "│")}`,
			`${theme.fg("frame", "│")} ${padAnsi(settingsLine, innerWidth)} ${theme.fg("frame", "│")}`,
			`${theme.fg("frame", "│")} ${padAnsi(hintLine, innerWidth)} ${theme.fg("frame", "│")}`,
		];

		return [framedTopBorder(title, safeWidth, theme), ...body, framedBottomBorder(safeWidth, theme)];
	} else if (safeWidth >= MID_MIN) {
		const targetLine = `  ${theme.fg("muted", "Target:")}  ${targetVal} · ${thinkVal}`;
		const contextLine = `  ${theme.fg("muted", "Context:")} ${clioMdStr} · ${codewikiStr} · ${handoffStr}`;
		const configLine = `  ${theme.fg("muted", "Config:")}  ${safetyStr} · ${profileStr}`;
		const hintLine = `  ${theme.fg("muted", "Hint:")}    ${hintStr}`;

		const innerWidth = safeWidth - 4;
		const body = [
			`${theme.fg("frame", "│")} ${padAnsi(targetLine, innerWidth)} ${theme.fg("frame", "│")}`,
			`${theme.fg("frame", "│")} ${padAnsi(contextLine, innerWidth)} ${theme.fg("frame", "│")}`,
			`${theme.fg("frame", "│")} ${padAnsi(configLine, innerWidth)} ${theme.fg("frame", "│")}`,
			`${theme.fg("frame", "│")} ${padAnsi(hintLine, innerWidth)} ${theme.fg("frame", "│")}`,
		];

		return [framedTopBorder(title, safeWidth, theme), ...body, framedBottomBorder(safeWidth, theme)];
	} else {
		return [
			title,
			`  ${targetVal} · ${thinkVal}`,
			`  ${clioMdStr} · ${codewikiStr}`,
			`  ${safetyStr} · ${theme.fg("accent", "Alt+U")} toggle`,
		].map((line) => truncateToWidth(line, safeWidth, "", true));
	}
}

export class WelcomeDashboard implements Component {
	private readonly snapshot: WelcomeDashboardStats;
	private readonly logo: Component | null;

	constructor(deps: WelcomeDashboardDeps) {
		this.snapshot = deriveWelcomeDashboardStats(deps);
		this.logo = createLogoImage(clioTheme());
	}

	render(width: number): string[] {
		const lines = buildWelcomeDashboardLines(this.snapshot, width);
		if (width < WIDE_MIN || !getCapabilities().images || !this.logo) return lines;
		return [...this.logo.render(width), ...lines];
	}

	invalidate(): void {}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): Component {
	return new WelcomeDashboard(deps);
}

export const __welcomeDashboardTest = { stripAnsi };
