import type { ClioSettings } from "../core/config.js";
import { readClioVersion } from "../core/package-root.js";
import type { ModesContract } from "../domains/modes/index.js";
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
import { type Component, truncateToWidth } from "../engine/tui.js";
import { abbreviateModelId, collapseHomePath } from "./theme/index.js";

export interface WelcomeDashboardDeps {
	modes: ModesContract;
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
	workspace: WorkspaceSnapshot | null;
	currentAvailable: boolean;
	activeCapabilities: string[];
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

export function deriveWelcomeDashboardStats(deps: WelcomeDashboardDeps): WelcomeDashboardStats {
	const settings = deps.getSettings?.();
	const statuses = deps.providers.list();
	const current = findCurrentStatus(statuses, settings);
	const targetLabel = current?.endpoint.id ?? settings?.orchestrator?.endpoint ?? "not configured";
	const modelLabel = settings?.orchestrator?.model ?? current?.endpoint.defaultModel ?? "not configured";
	const workspace = deps.getWorkspaceSnapshot?.() ?? null;
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
		workspace,
		currentAvailable,
		activeCapabilities,
	};
}

function gitReadout(workspace: WorkspaceSnapshot | null): string {
	if (!workspace?.isGit) return "git none";
	const branch = workspace.branch ?? "detached";
	const clean = workspace.dirty === false ? "✓" : workspace.dirty === true ? "!" : "?";
	return `git ${branch} ${clean}`;
}

export function buildWelcomeDashboardLines(stats: WelcomeDashboardStats, width: number): string[] {
	const cwd = collapseHomePath(stats.workspace?.cwd ?? process.cwd());
	const lines = [
		`◈ Clio Coder  v${readClioVersion()}`,
		`  ${stats.targetLabel} · ${abbreviateModelId(stats.modelLabel)} · think ${stats.thinkingLevel} · ${contextCapability(stats.activeCapabilities)}`,
		`  ${cwd} · ${gitReadout(stats.workspace)} · ${stats.activeTargets}/${stats.totalTargets} targets online`,
	];
	return lines.map((line) => truncateToWidth(line, Math.max(1, width), "", true));
}

export class WelcomeDashboard implements Component {
	private readonly snapshot: WelcomeDashboardStats;

	constructor(deps: WelcomeDashboardDeps) {
		this.snapshot = deriveWelcomeDashboardStats(deps);
	}

	render(width: number): string[] {
		return buildWelcomeDashboardLines(this.snapshot, width);
	}

	invalidate(): void {}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): Component {
	return new WelcomeDashboard(deps);
}

export const __welcomeDashboardTest = { stripAnsi };
