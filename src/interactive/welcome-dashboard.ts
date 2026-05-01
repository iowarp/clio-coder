import type { ClioSettings } from "../core/config.js";
import type { ModesContract } from "../domains/modes/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import type { EndpointStatus, ProvidersContract } from "../domains/providers/index.js";
import type { ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import { type Component, truncateToWidth, visibleWidth } from "../engine/tui.js";
import { styleForMode } from "./mode-theme.js";

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const GREEN = "\u001b[38;5;114m";
const CYAN = "\u001b[38;5;80m";
const MAGENTA = "\u001b[38;5;207m";
const AMBER = "\u001b[38;5;221m";
const RED = "\u001b[38;5;203m";

const LOGO = [
	" CCCC  L      III   OOO ",
	"C      L       I   O   O",
	"C      L       I   O   O",
	" CCCC  LLLLL  III   OOO ",
];

export interface WelcomeDashboardDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	observability: ObservabilityContract;
	getContextUsage?: () => ContextUsageSnapshot;
	getSettings?: () => Readonly<ClioSettings>;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	selfDev: boolean;
}

export interface WelcomeDashboardStats {
	activeTargets: number;
	totalTargets: number;
	runtimes: number;
	workerProfiles: number;
	totalModels: number;
	localModels: number;
	cloudModels: number;
	cliModels: number;
	targetLabel: string;
	modelLabel: string;
	contextPercent: number | null;
	avgLatencyMs: number | null;
	mode: string;
	selfDev: boolean;
	workspace: WorkspaceSnapshot | null;
}

function color(text: string, fn: string): string {
	return `${fn}${text}${RESET}`;
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

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function joinAnsi(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(gap)}${right}`;
}

function bar(percent: number | null, width: number): string {
	if (percent === null) return `${DIM}${"░".repeat(width)}${RESET}`;
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const tint = clamped >= 90 ? RED : clamped >= 70 ? AMBER : GREEN;
	return `${tint}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(Math.max(0, width - filled))}${RESET}`;
}

function uniqueModels(status: EndpointStatus): string[] {
	const seen = new Set<string>();
	if (status.endpoint.defaultModel) seen.add(status.endpoint.defaultModel);
	for (const model of status.endpoint.wireModels ?? []) seen.add(model);
	for (const model of status.discoveredModels) seen.add(model);
	for (const model of status.runtime?.knownModels ?? []) seen.add(model);
	return [...seen];
}

function modelBucket(status: EndpointStatus): "local" | "cloud" | "cli" {
	const tier = status.runtime?.tier;
	if (
		tier === "cli" ||
		tier === "cli-gold" ||
		tier === "cli-silver" ||
		tier === "cli-bronze" ||
		status.runtime?.kind === "subprocess"
	) {
		return "cli";
	}
	if (
		tier === "protocol" ||
		tier === "local-native" ||
		status.endpoint.url?.includes("127.0.0.1") ||
		status.endpoint.url?.includes("localhost")
	) {
		return "local";
	}
	return "cloud";
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

export function deriveWelcomeDashboardStats(deps: WelcomeDashboardDeps): WelcomeDashboardStats {
	const settings = deps.getSettings?.();
	const statuses = deps.providers.list();
	const current = findCurrentStatus(statuses, settings);
	let localModels = 0;
	let cloudModels = 0;
	let cliModels = 0;
	for (const status of statuses) {
		const count = uniqueModels(status).length;
		const bucket = modelBucket(status);
		if (bucket === "local") localModels += count;
		else if (bucket === "cli") cliModels += count;
		else cloudModels += count;
	}
	const targetLabel = current?.endpoint.id ?? settings?.orchestrator?.endpoint ?? "not configured";
	const modelLabel = settings?.orchestrator?.model ?? current?.endpoint.defaultModel ?? "not configured";
	const usage = deps.getContextUsage?.() ?? null;
	const contextPercent = typeof usage?.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null;
	const latencies = statuses
		.map((status) => status.health.latencyMs)
		.filter((value): value is number => typeof value === "number");
	const avgLatencyMs = latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
	const workspace = deps.getWorkspaceSnapshot?.() ?? null;
	return {
		activeTargets: statuses.filter(activeStatus).length,
		totalTargets: statuses.length,
		runtimes: new Set(statuses.map((status) => status.endpoint.runtime)).size,
		workerProfiles:
			Object.keys(settings?.workers?.profiles ?? {}).length + (settings?.workers?.default?.endpoint ? 1 : 0),
		totalModels: localModels + cloudModels + cliModels,
		localModels,
		cloudModels,
		cliModels,
		targetLabel,
		modelLabel,
		contextPercent,
		avgLatencyMs,
		mode: deps.modes.current().toLowerCase(),
		selfDev: deps.selfDev,
		workspace,
	};
}

function modeStatus(stats: Pick<WelcomeDashboardStats, "mode" | "selfDev">): string {
	const mode = styleForMode(stats.mode, `mode ${stats.mode}`);
	return stats.selfDev ? `${mode} · ${color("DEV MODE", MAGENTA)}` : mode;
}

function compactLine(stats: WelcomeDashboardStats, width: number): string[] {
	const status = color("Clio Coder", CYAN);
	const right = `${modeStatus(stats)}${color(
		` · ${stats.targetLabel}/${stats.modelLabel} · ${stats.activeTargets}/${stats.totalTargets} targets`,
		DIM,
	)}`;
	return [truncateToWidth(joinAnsi(status, right, Math.max(20, width)), width, "", true)];
}

function framedPanel(title: string, lines: string[], width: number): string[] {
	const content = Math.max(10, width - 4);
	const out = [`╭─ ${title} ${"─".repeat(Math.max(0, content - visibleWidth(title) - 1))}╮`];
	for (const line of lines) {
		out.push(`│ ${padAnsi(line, content)} │`);
	}
	out.push(`╰${"─".repeat(content + 2)}╯`);
	return out;
}

function twoColumn(left: string[], right: string[], width: number): string[] {
	const gap = 2;
	const leftWidth = Math.max(32, Math.floor((width - gap) * 0.5));
	const rightWidth = Math.max(28, width - gap - leftWidth);
	const leftLines = framedPanel("Infrastructure", left, leftWidth);
	const rightLines = framedPanel("Context", right, rightWidth);
	const rows = Math.max(leftLines.length, rightLines.length);
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		out.push(`${padAnsi(leftLines[i] ?? "", leftWidth)}${" ".repeat(gap)}${padAnsi(rightLines[i] ?? "", rightWidth)}`);
	}
	return out;
}

function formatLatency(ms: number | null): string {
	if (ms === null) return "n/a";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function gitStatusLabel(ws: WorkspaceSnapshot): string {
	if (ws.dirty === null) return "unknown";
	return ws.dirty ? "dirty" : "clean";
}

function aheadBehindLabel(ws: WorkspaceSnapshot): string {
	const parts: string[] = [];
	if (typeof ws.ahead === "number" && ws.ahead > 0) parts.push(`ahead ${ws.ahead}`);
	if (typeof ws.behind === "number" && ws.behind > 0) parts.push(`behind ${ws.behind}`);
	return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

function recentCommitLines(ws: WorkspaceSnapshot): string[] {
	return ws.recentCommits.slice(0, 2).map((commit) => {
		const sha = commit.sha.length > 7 ? commit.sha.slice(0, 7) : commit.sha;
		return `commit: ${sha} ${commit.subject}`;
	});
}

export function buildWelcomeDashboardLines(stats: WelcomeDashboardStats, width: number): string[] {
	if (width < 84) return compactLine(stats, width);
	const inner = Math.min(118, Math.max(84, width));
	const content = inner - 4;
	const pct = stats.contextPercent === null ? "idle" : `${Math.round(stats.contextPercent)}%`;
	const title = "Clio Coder";
	const top = `╭─ ${color(title, BOLD)} ${"─".repeat(Math.max(0, content - title.length - 1))}╮`;
	const out: string[] = [top];
	out.push(`│ ${padAnsi(joinAnsi("interactive workspace", modeStatus(stats), content), content)} │`);
	out.push(`│ ${padAnsi("", content)} │`);
	const logoWidth = 25;
	const panelWidth = content - logoWidth - 3;
	const current = [
		`${color("Target", BOLD)} ${color(stats.targetLabel, CYAN)}`,
		`${color("Model ", BOLD)} ${color(stats.modelLabel, GREEN)}`,
		`Models: ${stats.totalModels} total  ${color(`${stats.localModels} local`, GREEN)}  ${color(`${stats.cloudModels} cloud`, CYAN)}  ${color(`${stats.cliModels} cli`, MAGENTA)}`,
	];
	for (let i = 0; i < LOGO.length; i++) {
		out.push(`│ ${padAnsi(color(LOGO[i] ?? "", GREEN), logoWidth)}   ${padAnsi(current[i] ?? "", panelWidth)} │`);
	}
	out.push(`│ ${padAnsi("", content)} │`);
	for (const line of twoColumn(
		[
			`Targets: ${stats.activeTargets} active / ${stats.totalTargets} total`,
			`Runtimes: ${stats.runtimes}`,
			`Worker profiles: ${stats.workerProfiles}`,
		],
		[
			`Context usage: ${pct}`,
			`${bar(stats.contextPercent, 18)}  avg latency ${formatLatency(stats.avgLatencyMs)}`,
			"Shift+Tab modes · Ctrl+L model · /hotkeys",
		],
		content,
	)) {
		out.push(`│ ${padAnsi(line, content)} │`);
	}
	if (stats.workspace) {
		const ws = stats.workspace;
		const cwdLabel = ws.projectType === "unknown" ? ws.cwd : `${ws.cwd} · ${ws.projectType}`;
		const lines: string[] = [cwdLabel];
		if (ws.isGit) {
			const dirty = gitStatusLabel(ws);
			const position = aheadBehindLabel(ws);
			const remote = ws.remoteUrl ? ` · remote: ${ws.remoteUrl.replace(/^https?:\/\//, "")}` : "";
			lines.push(`git: ${ws.branch ?? "(detached)"} (${dirty}${position})${remote}`);
			lines.push(...recentCommitLines(ws));
		}
		out.push(`│ ${padAnsi("", content)} │`);
		for (const line of framedPanel(
			"Workspace",
			lines.map((l) => truncateToWidth(l, content - 4, "…", true)),
			content,
		)) {
			out.push(`│ ${padAnsi(line, content)} │`);
		}
	}
	out.push(`╰${"─".repeat(content + 2)}╯`);
	return out.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line));
}

export class WelcomeDashboard implements Component {
	constructor(private readonly deps: WelcomeDashboardDeps) {}

	render(width: number): string[] {
		return buildWelcomeDashboardLines(deriveWelcomeDashboardStats(this.deps), width);
	}

	invalidate(): void {}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): Component {
	return new WelcomeDashboard(deps);
}

export const __welcomeDashboardTest = { stripAnsi };
