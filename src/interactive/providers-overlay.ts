import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type {
	AuthStatus,
	CapabilityFlags,
	EndpointStatus,
	ProvidersContract,
	RuntimeResolutionDiagnostic,
} from "../domains/providers/index.js";
import {
	type Component,
	Loader,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { buildHint, FocusBox, IDENTITY, showClioOverlayFrame } from "./overlay-frame.js";
import { applySettingChange } from "./overlays/settings.js";
import { type ClioToken, clioTheme } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 96;
const TARGET_COL_WIDTH = 20;
const RUNTIME_COL_WIDTH = 18;
const HEALTH_COL_WIDTH = 16;
const AUTH_COL_WIDTH = 14;

export const PROVIDERS_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;
export const PROVIDERS_OVERLAY_DISCOVERED_PREVIEW = 4;

export interface TargetAuthDisplay {
	summary: string;
	detail: string;
}

export interface TargetsHubUseDeps {
	getSettings: () => Readonly<ClioSettings> | undefined;
	writeSettings: (next: ClioSettings) => void;
}

export type TargetsHubNoticeLevel = "info" | "success" | "warning" | "error";

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function endpointLocation(status: EndpointStatus): string {
	return status.endpoint.url ?? "(no url)";
}

function healthLabel(status: EndpointStatus): string {
	switch (status.health.status) {
		case "healthy":
			return "ok";
		case "degraded":
			return "degraded";
		case "down":
			return "down";
		default:
			return "unknown";
	}
}

function healthGlyph(status: EndpointStatus): string {
	switch (status.health.status) {
		case "healthy":
			return "●";
		case "degraded":
			return "◐";
		case "down":
			return "○";
		default:
			return "·";
	}
}

function healthToken(status: EndpointStatus): ClioToken {
	switch (status.health.status) {
		case "healthy":
			return "success";
		case "degraded":
			return "warning";
		case "down":
			return "error";
		default:
			return "dim";
	}
}

function latencyTag(status: EndpointStatus): string {
	const ms = status.health.latencyMs;
	return typeof ms === "number" ? `${ms}ms` : "-";
}

function formatHealthCompact(status: EndpointStatus): string {
	const text = `${healthGlyph(status)} ${healthLabel(status)} ${latencyTag(status)}`;
	return clioTheme().fg(healthToken(status), text);
}

function formatHealthRow(status: EndpointStatus): string {
	return `    health: ${healthLabel(status)}  latency: ${latencyTag(status)}`;
}

function formatRuntimeRow(status: EndpointStatus): string {
	const runtimeId = status.runtime?.id ?? status.endpoint.runtime;
	const runtimeName = status.runtime?.displayName ?? status.endpoint.runtime;
	return `    runtime: ${runtimeId}  ${runtimeName}`;
}

function formatAuthRow(authText: string): string {
	return `    auth: ${authText}`;
}

export function formatCapabilitiesRow(caps: CapabilityFlags): string {
	const ctx = caps.contextWindow > 0 ? `${caps.contextWindow}ctx` : "?ctx";
	const max = caps.maxTokens > 0 ? `${caps.maxTokens}max` : "?max";
	const flags: string[] = [];
	if (caps.tools) flags.push("tools");
	if (caps.reasoning) flags.push("reasoning");
	if (caps.vision) flags.push("vision");
	if (caps.embeddings) flags.push("embeddings");
	if (caps.rerank) flags.push("rerank");
	if (caps.fim) flags.push("fim");
	const flagText = flags.length > 0 ? flags.join("+") : "chat-only";
	return `    caps: ${ctx}  ${max}  ${flagText}`;
}

function formatReasonRow(status: EndpointStatus): string {
	const prefix = status.available ? "ready" : "unavailable";
	return `    ${prefix}: ${status.reason || "-"}`;
}

function formatDiscoveredRow(status: EndpointStatus): string {
	const ids = status.discoveredModels;
	if (ids.length === 0) return "    models: (no probe yet)";
	const preview = ids.slice(0, PROVIDERS_OVERLAY_DISCOVERED_PREVIEW).join(", ");
	const suffix =
		ids.length > PROVIDERS_OVERLAY_DISCOVERED_PREVIEW ? ` (+${ids.length - PROVIDERS_OVERLAY_DISCOVERED_PREVIEW})` : "";
	return `    models: ${preview}${suffix}`;
}

function formatRuntimeResolutionDiagnostic(diagnostic: RuntimeResolutionDiagnostic): string {
	return `${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`;
}

function probeDiagnostic(err: unknown): RuntimeResolutionDiagnostic {
	return {
		severity: "error",
		code: "probe-failed",
		message: err instanceof Error ? err.message : String(err),
	};
}

function defaultAuthDisplay(status: EndpointStatus): TargetAuthDisplay {
	if (!status.runtime) return { summary: "unknown", detail: "unknown-runtime" };
	const auth = status.runtime.auth;
	if (auth === "none") return { summary: "none", detail: "not-required" };
	return { summary: auth, detail: auth };
}

function authSummaryForRuntimeAuth(runtimeAuth: string): string {
	if (runtimeAuth === "oauth") return "oauth";
	if (runtimeAuth === "api-key") return "api-key";
	return runtimeAuth;
}

export function formatTargetAuthDisplay(status: EndpointStatus, auth: AuthStatus | null): TargetAuthDisplay {
	if (!status.runtime) return { summary: "unknown", detail: "unknown-runtime" };
	if (!auth) return defaultAuthDisplay(status);
	if (!auth.available) {
		return {
			summary: "disconnected",
			detail: `missing ${status.runtime.auth} (${auth.detail ?? auth.providerId})`,
		};
	}
	switch (auth.source) {
		case "runtime-override":
			return { summary: "api-key", detail: `override:${auth.providerId}` };
		case "stored-api-key":
			return { summary: "api-key", detail: `store:api_key:${auth.providerId}` };
		case "stored-oauth":
			return { summary: "oauth", detail: `store:oauth:${auth.providerId}` };
		case "environment":
			return { summary: "env", detail: auth.detail ? `env:${auth.detail}` : `env:${auth.providerId}` };
		case "fallback":
			return {
				summary: authSummaryForRuntimeAuth(status.runtime.auth),
				detail: `fallback:${auth.providerId}`,
			};
		case "not-required":
			return { summary: "none", detail: "not-required" };
		case "none":
			return { summary: "disconnected", detail: `missing ${status.runtime.auth} (${auth.providerId})` };
	}
}

export function buildTargetAuthMap(
	statuses: ReadonlyArray<EndpointStatus>,
	providers: ProvidersContract,
): ReadonlyMap<string, TargetAuthDisplay> {
	const out = new Map<string, TargetAuthDisplay>();
	for (const status of statuses) {
		if (!status.runtime) {
			out.set(status.endpoint.id, { summary: "unknown", detail: "unknown-runtime" });
			continue;
		}
		out.set(
			status.endpoint.id,
			formatTargetAuthDisplay(status, providers.auth.statusForTarget(status.endpoint, status.runtime)),
		);
	}
	return out;
}

export function formatProbeNotice(status: EndpointStatus): string {
	return `probed ${status.endpoint.id} (${healthLabel(status)} ${latencyTag(status)})`;
}

export function formatProbeAllNotice(count: number): string {
	return `probed ${count} target${count === 1 ? "" : "s"}`;
}

function healthSortRank(status: EndpointStatus): number {
	return status.health.status === "healthy" ? 0 : 1;
}

export function sortTargetStatuses(
	statuses: ReadonlyArray<EndpointStatus>,
	activeEndpointId?: string | null,
): EndpointStatus[] {
	return [...statuses].sort((a, b) => {
		const aActive = activeEndpointId !== null && activeEndpointId !== undefined && a.endpoint.id === activeEndpointId;
		const bActive = activeEndpointId !== null && activeEndpointId !== undefined && b.endpoint.id === activeEndpointId;
		if (aActive !== bActive) return aActive ? -1 : 1;
		const health = healthSortRank(a) - healthSortRank(b);
		if (health !== 0) return health;
		return a.endpoint.id.localeCompare(b.endpoint.id);
	});
}

export function toggleExpandedTarget(currentExpandedId: string | null, selectedId: string | null): string | null {
	if (!selectedId) return null;
	return currentExpandedId === selectedId ? null : selectedId;
}

function modelLabelForStatus(
	status: EndpointStatus,
	activeEndpointId?: string | null,
	activeModelId?: string | null,
): string {
	if (status.endpoint.id === activeEndpointId && activeModelId) return activeModelId;
	return status.endpoint.defaultModel ?? status.endpoint.wireModels?.[0] ?? "(no model)";
}

function formatCollapsedTargetRow(
	status: EndpointStatus,
	options: {
		width: number;
		selected: boolean;
		active: boolean;
		activeEndpointId?: string | null;
		activeModelId?: string | null;
		auth: TargetAuthDisplay;
	},
): string {
	const theme = clioTheme();
	const marker = options.selected ? theme.fg("accent", "▸") : " ";
	const targetBudget = options.active ? Math.max(1, TARGET_COL_WIDTH - " active".length) : TARGET_COL_WIDTH;
	const id = truncateToWidth(status.endpoint.id, targetBudget, "", true);
	const target = options.active ? `${theme.style("title", id, { bold: true })} ${theme.fg("success", "active")}` : id;
	const runtime = status.runtime?.displayName ?? status.endpoint.runtime;
	const prefix = [
		`${marker} ${padAnsi(target, TARGET_COL_WIDTH)}`,
		padAnsi(runtime, RUNTIME_COL_WIDTH),
		padAnsi(formatHealthCompact(status), HEALTH_COL_WIDTH),
		padAnsi(options.auth.summary, AUTH_COL_WIDTH),
	].join("  ");
	const model = modelLabelForStatus(status, options.activeEndpointId, options.activeModelId);
	const modelPrefix = `${prefix}  `;
	if (visibleWidth(modelPrefix) >= options.width) return truncateToWidth(prefix, options.width, "", true);
	return `${modelPrefix}${truncateToWidth(model, options.width - visibleWidth(modelPrefix), "", true)}`;
}

function formatTargetDetailLines(status: EndpointStatus, auth: TargetAuthDisplay, width: number): string[] {
	const lines = [
		`    url: ${endpointLocation(status)}`,
		formatRuntimeRow(status),
		formatHealthRow(status),
		formatAuthRow(auth.detail),
		formatCapabilitiesRow(status.capabilities),
		formatReasonRow(status),
		formatDiscoveredRow(status),
	];
	return lines.map((line) => truncateToWidth(line, width, "", true));
}

export function formatTargetsHubBodyLines(
	statuses: ReadonlyArray<EndpointStatus>,
	options: {
		error?: RuntimeResolutionDiagnostic | null;
		selectedId?: string | null;
		expandedId?: string | null;
		activeEndpointId?: string | null;
		activeModelId?: string | null;
		authByEndpoint?: ReadonlyMap<string, TargetAuthDisplay>;
	} = {},
	width = DEFAULT_CONTENT_WIDTH,
): string[] {
	const lines: string[] = [];
	if (options.error) {
		lines.push(formatRuntimeResolutionDiagnostic(options.error));
		lines.push("");
	}
	if (statuses.length === 0) {
		lines.push("no targets configured (run clio configure)");
		return lines;
	}
	const activeEndpointId = options.activeEndpointId ?? null;
	const activeModelId = options.activeModelId ?? null;
	for (const status of sortTargetStatuses(statuses, activeEndpointId)) {
		const id = status.endpoint.id;
		const auth = options.authByEndpoint?.get(id) ?? defaultAuthDisplay(status);
		lines.push(
			formatCollapsedTargetRow(status, {
				width,
				selected: options.selectedId === id,
				active: activeEndpointId === id,
				activeEndpointId,
				activeModelId,
				auth,
			}),
		);
		if (options.expandedId === id) {
			lines.push(...formatTargetDetailLines(status, auth, width));
		}
	}
	return lines;
}

export function buildTargetHubUseSettings(settings: Readonly<ClioSettings>, targetId: string): ClioSettings {
	const next = structuredClone(settings) as ClioSettings;
	applySettingChange(next, "orchestrator.endpoint", targetId);
	return next;
}

export function applyTargetsHubUseAction(targetId: string, deps: TargetsHubUseDeps): ClioSettings | null {
	const current = deps.getSettings();
	if (!current) return null;
	const next = buildTargetHubUseSettings(current, targetId);
	deps.writeSettings(next);
	return next;
}

class ProvidersOverlayView implements Component {
	constructor(
		private getState: () => {
			statuses: ReadonlyArray<EndpointStatus>;
			error: RuntimeResolutionDiagnostic | null;
			selectedId: string | null;
			expandedId: string | null;
			authByEndpoint: ReadonlyMap<string, TargetAuthDisplay>;
			activeEndpointId: string | null;
			activeModelId: string | null;
		},
	) {}

	render(width: number): string[] {
		const { statuses, error, selectedId, expandedId, authByEndpoint, activeEndpointId, activeModelId } = this.getState();
		return formatTargetsHubBodyLines(
			statuses,
			{
				error,
				selectedId,
				expandedId,
				authByEndpoint,
				activeEndpointId,
				activeModelId,
			},
			width,
		);
	}

	invalidate(): void {}
}

export interface OpenProvidersOverlayOptions {
	onComplete?: () => void;
	bus?: SafeEventBus;
	getSettings?: () => Readonly<ClioSettings> | undefined;
	writeSettings?: (next: ClioSettings) => void;
	connectTarget?: (targetId: string) => Promise<void> | void;
	disconnectTarget?: (targetId: string) => Promise<void> | void;
	notice?: (level: TargetsHubNoticeLevel, text: string, key?: string) => void;
}

/**
 * Mount the targets hub. It runs the live probe sweep async, subscribes to
 * ProviderHealth bus events for incremental updates, and keeps all target
 * actions on the selected row.
 */
export function openProvidersOverlay(
	tui: TUI,
	providers: ProvidersContract,
	options?: OpenProvidersOverlayOptions,
): OverlayHandle {
	const lifecycle = new AbortController();
	let statuses: ReadonlyArray<EndpointStatus> = providers.list();
	let error: RuntimeResolutionDiagnostic | null = null;
	let expandedId: string | null = null;
	let actionInFlight: string | null = null;

	const activeEndpointId = (): string | null => options?.getSettings?.()?.orchestrator.endpoint ?? null;
	const activeModelId = (): string | null => options?.getSettings?.()?.orchestrator.model ?? null;
	const sortedStatuses = (): EndpointStatus[] => sortTargetStatuses(statuses, activeEndpointId());
	let selectedId: string | null = sortedStatuses()[0]?.endpoint.id ?? null;
	let authByEndpoint = buildTargetAuthMap(statuses, providers);

	const refreshState = (): void => {
		statuses = providers.list();
		authByEndpoint = buildTargetAuthMap(statuses, providers);
		const sorted = sortedStatuses();
		if (selectedId && !sorted.some((s) => s.endpoint.id === selectedId)) {
			selectedId = sorted[0]?.endpoint.id ?? null;
		}
		if (expandedId && !sorted.some((s) => s.endpoint.id === expandedId)) {
			expandedId = null;
		}
	};

	const selectedStatus = (): EndpointStatus | null => {
		if (!selectedId) return null;
		return statuses.find((status) => status.endpoint.id === selectedId) ?? null;
	};

	const view = new ProvidersOverlayView(() => ({
		statuses,
		error,
		selectedId,
		expandedId,
		authByEndpoint,
		activeEndpointId: activeEndpointId(),
		activeModelId: activeModelId(),
	}));

	const runAction = (name: string, fn: () => Promise<void>): void => {
		if (lifecycle.signal.aborted || actionInFlight) return;
		actionInFlight = name;
		void (async () => {
			try {
				await fn();
			} catch (err) {
				error = probeDiagnostic(err);
			} finally {
				actionInFlight = null;
				if (!lifecycle.signal.aborted) {
					refreshState();
					tui.requestRender();
				}
			}
		})();
	};

	const keys: ProvidersOverlayKeys = {
		nextSelection: (direction) => {
			const sorted = sortedStatuses();
			if (sorted.length === 0) return;
			const idx = sorted.findIndex((s) => s.endpoint.id === selectedId);
			if (idx === -1) {
				selectedId = sorted[0]?.endpoint.id ?? null;
				return;
			}
			const len = sorted.length;
			const nextIdx = (idx + (direction === "down" ? 1 : len - 1)) % len;
			const picked = sorted[nextIdx];
			if (picked) selectedId = picked.endpoint.id;
		},
		toggleDetail: () => {
			expandedId = toggleExpandedTarget(expandedId, selectedId);
			view.invalidate();
			tui.requestRender();
		},
		useSelected: () => {
			const status = selectedStatus();
			if (!status) return;
			if (!options?.getSettings || !options.writeSettings) {
				options?.notice?.("warning", "targets: settings writer unavailable", "targets:use");
				return;
			}
			const next = applyTargetsHubUseAction(status.endpoint.id, {
				getSettings: options.getSettings,
				writeSettings: options.writeSettings,
			});
			const model = next?.orchestrator.model ?? "(no model)";
			options.notice?.("success", `using target ${status.endpoint.id} (${model})`, `targets:use:${status.endpoint.id}`);
			refreshState();
			tui.requestRender();
		},
		connectSelected: () => {
			const status = selectedStatus();
			if (!status) return;
			if (!options?.connectTarget) {
				options?.notice?.("warning", "targets: connect flow unavailable", "targets:connect");
				return;
			}
			runAction("connect", async () => {
				await options.connectTarget?.(status.endpoint.id);
				await providers.probeEndpoint(status.endpoint.id);
			});
		},
		disconnectSelected: () => {
			const status = selectedStatus();
			if (!status) return;
			if (!options?.disconnectTarget) {
				options?.notice?.("warning", "targets: disconnect flow unavailable", "targets:disconnect");
				return;
			}
			runAction("disconnect", async () => {
				await options.disconnectTarget?.(status.endpoint.id);
			});
		},
		probeSelected: () => {
			const status = selectedStatus();
			if (!status) return;
			runAction("probe", async () => {
				await providers.probeEndpoint(status.endpoint.id);
				const probed = providers.list().find((s) => s.endpoint.id === status.endpoint.id) ?? status;
				options?.notice?.("success", formatProbeNotice(probed), `targets:probe:${status.endpoint.id}`);
			});
		},
		probeAll: () => {
			runAction("probe-all", async () => {
				await providers.probeAllLive();
				options?.notice?.("success", formatProbeAllNotice(providers.list().length), "targets:probe-all");
			});
		},
	};

	const box = new FocusBox(view, {
		x: 0,
		onInput: (data) => {
			if (data === "j" || matchesKey(data, "down")) {
				keys.nextSelection("down");
				view.invalidate();
				tui.requestRender();
				return;
			}
			if (data === "k" || matchesKey(data, "up")) {
				keys.nextSelection("up");
				view.invalidate();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "enter") || data === "\n") {
				keys.toggleDetail();
				return;
			}
			if (data === "u") {
				keys.useSelected();
				return;
			}
			if (data === "c") {
				keys.connectSelected();
				return;
			}
			if (data === "d") {
				keys.disconnectSelected();
				return;
			}
			if (data === "r") {
				keys.probeSelected();
				return;
			}
			if (data === "R") {
				keys.probeAll();
			}
		},
	});
	const loader = new Loader(tui, IDENTITY, IDENTITY, "Probing targets...");
	box.clear();
	box.addChild(loader);
	const handle = showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: PROVIDERS_OVERLAY_WIDTH,
		title: "Targets",
		footerHint: buildHint("browse", [
			{ key: "Enter", verb: "detail" },
			{ key: "u", verb: "use" },
			{ key: "c", verb: "connect" },
			{ key: "d", verb: "disconnect" },
			{ key: "r", verb: "probe" },
			{ key: "R", verb: "probe all" },
		]),
	});

	const unsubscribeHealth = options?.bus?.on(BusChannels.ProviderHealth, () => {
		if (lifecycle.signal.aborted) return;
		refreshState();
		tui.requestRender();
	});

	const finalize = (nextError: RuntimeResolutionDiagnostic | null): void => {
		if (lifecycle.signal.aborted) return;
		loader.stop();
		refreshState();
		error = nextError;
		box.clear();
		box.addChild(view);
		tui.requestRender();
		options?.onComplete?.();
	};

	void (async () => {
		let probeError: RuntimeResolutionDiagnostic | null = null;
		try {
			await providers.probeAllLive();
		} catch (err) {
			probeError = probeDiagnostic(err);
		}
		if (lifecycle.signal.aborted) return;
		finalize(probeError);
	})();

	return {
		...handle,
		hide(): void {
			if (!lifecycle.signal.aborted) {
				lifecycle.abort();
			}
			unsubscribeHealth?.();
			loader.stop();
			handle.hide();
		},
	};
}

interface ProvidersOverlayKeys {
	nextSelection(direction: "up" | "down"): void;
	toggleDetail(): void;
	useSelected(): void;
	connectSelected(): void;
	disconnectSelected(): void;
	probeSelected(): void;
	probeAll(): void;
}
