import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { readClioVersion, resolvePackageRoot } from "../core/package-root.js";
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
import {
	abbreviateModelId,
	type ClioTheme,
	type ClioToken,
	clioTheme,
	GLYPH,
	joinChips,
	keyHint,
	rule,
	sectionTag,
} from "./theme/index.js";

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

function contextCapability(labels: ReadonlyArray<string>): string {
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
	// Health is only worth a chip once a probe has produced a real verdict.
	// Unprobed ("unknown") and unconfigured targets render nothing rather than
	// noise like "unknown" or "not configured".
	if (!status || status.health.status === "unknown") return null;
	const latency =
		typeof status.health.latencyMs === "number" && Number.isFinite(status.health.latencyMs)
			? ` ${Math.round(status.health.latencyMs)}ms`
			: "";
	if (activeStatus(status)) return `${status.health.status}${latency}`;
	const reason = status.health.lastError ?? status.reason;
	return reason && reason !== status.health.status ? `${status.health.status}: ${reason}` : status.health.status;
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
	};
}

/** Welcome header responsive bands. */
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

function joinColumns(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, Math.max(1, width), "", true);
}

function capabilityChips(theme: ClioTheme, stats: WelcomeDashboardStats, limit: number): string[] {
	return stats.activeCapabilities
		.filter((label) => !label.endsWith(" ctx"))
		.slice(0, Math.max(0, limit))
		.map((cap) => theme.fg("accentDeep", cap));
}

function extensionChip(theme: ClioTheme, stats: WelcomeDashboardStats): string | null {
	// Hide entirely when nothing is installed; "ext 0/0" is pure noise.
	if (!stats.extensions || stats.extensions.installed <= 0) return null;
	return theme.fg("muted", `ext ${stats.extensions.active}/${stats.extensions.installed}`);
}

function healthChip(theme: ClioTheme, label: string | null): string | null {
	if (!label) return null;
	const token: ClioToken = label.startsWith("healthy") ? "success" : label.startsWith("down") ? "error" : "warning";
	return theme.fg(token, label);
}

function thinkingChip(theme: ClioTheme, level: string): string {
	const active = level !== "off" && level !== "none";
	const glyph = theme.fg(active ? "reason" : "dim", active ? GLYPH.thinkOn : GLYPH.thinkOff);
	return `think ${glyph} ${theme.fg("muted", level)}`;
}

function onlineChip(theme: ClioTheme, stats: WelcomeDashboardStats): string {
	const allOnline = stats.totalTargets > 0 && stats.activeTargets >= stats.totalTargets;
	const dot = theme.fg(allOnline ? "success" : "warning", GLYPH.running);
	return `${dot} ${theme.fg("muted", `${stats.activeTargets}/${stats.totalTargets} online`)}`;
}

function section(theme: ClioTheme, token: ClioToken, label: string, content: string): string {
	return ` ${sectionTag(theme, token, label, 6)} ${content}`;
}

export function buildWelcomeDashboardLines(stats: WelcomeDashboardStats, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);

	const title = theme.style("title", `${GLYPH.agent} Clio Coder`, { bold: true });
	const versionTag = theme.fg("dim", `v${readClioVersion()}`);
	const endpoint = theme.fg("accent", stats.targetLabel);
	const model = abbreviateModelId(stats.modelLabel);
	const think = thinkingChip(theme, stats.thinkingLevel);
	const context = theme.fg("info", contextCapability(stats.activeCapabilities));
	const health = healthChip(theme, stats.targetHealthLabel);
	const ext = extensionChip(theme, stats);
	// Dashboard toggle is Alt+U; the live workspace/git ownership moved to the
	// footer so the branch is never duplicated between header and footer.
	const affordance = keyHint(theme, "Alt+U", "dashboard");
	const identity = joinColumns(joinChips(theme, [title, versionTag]), onlineChip(theme, stats), safeWidth);

	let lines: string[];
	if (safeWidth >= WIDE_MIN) {
		const caps = joinChips(theme, [...capabilityChips(theme, stats, 4), ext]);
		lines = [
			identity,
			rule(theme, safeWidth),
			section(theme, "accent", "target", joinChips(theme, [endpoint, model, think, context, health])),
			joinColumns(section(theme, "reason", "caps", caps), affordance, safeWidth),
		];
	} else if (safeWidth >= MID_MIN) {
		const caps = joinChips(theme, [...capabilityChips(theme, stats, 3), ext]);
		lines = [
			identity,
			section(theme, "accent", "target", joinChips(theme, [endpoint, model, think, context])),
			joinColumns(section(theme, "reason", "caps", caps), affordance, safeWidth),
		];
	} else {
		lines = [
			joinChips(theme, [title, versionTag]),
			joinChips(theme, [endpoint, model, think]),
			joinChips(theme, [...capabilityChips(theme, stats, 2), theme.fg("accentDeep", "Alt+U")]),
		];
	}
	return lines.map((line) => truncateToWidth(line, safeWidth, "", true));
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
