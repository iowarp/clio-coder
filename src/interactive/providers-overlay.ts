import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type {
	CapabilityFlags,
	EndpointStatus,
	ProvidersContract,
	RuntimeResolutionDiagnostic,
} from "../domains/providers/index.js";
import { type Component, Loader, matchesKey, type OverlayHandle, type TUI } from "../engine/tui.js";
import { FocusBox, IDENTITY, showClioOverlayFrame } from "./overlay-frame.js";

const DEFAULT_CONTENT_WIDTH = 76;
const HINT = "[r] probe selected  [R] probe all  [Esc] close";

export const PROVIDERS_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;
export const PROVIDERS_OVERLAY_DISCOVERED_PREVIEW = 4;

function healthTag(status: EndpointStatus): string {
	switch (status.health.status) {
		case "healthy":
			return "ok";
		case "degraded":
			return "degraded";
		case "down":
			return "off";
		default:
			return "unknown";
	}
}

function latencyTag(status: EndpointStatus): string {
	const ms = status.health.latencyMs;
	return typeof ms === "number" ? `${ms}ms` : "-";
}

function endpointLocation(status: EndpointStatus): string {
	return status.endpoint.url ?? "(no url)";
}

function formatHeaderRow(status: EndpointStatus): string {
	const ep = status.endpoint;
	const runtimeId = status.runtime?.id ?? ep.runtime;
	const runtimeName = status.runtime?.displayName ?? ep.runtime;
	return `  ${ep.id}  ${runtimeId}  ${runtimeName}`;
}

function formatLocationRow(status: EndpointStatus): string {
	return `    url: ${endpointLocation(status)}`;
}

function formatHealthRow(status: EndpointStatus): string {
	return `    health: ${healthTag(status)}  latency: ${latencyTag(status)}`;
}

function formatAuthRow(authText: string): string {
	return `    auth: ${authText}`;
}

function formatCapabilitiesRow(caps: CapabilityFlags): string {
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

function formatProvidersOverlayBodyLines(
	statuses: ReadonlyArray<EndpointStatus>,
	options?: {
		error?: RuntimeResolutionDiagnostic | null;
		selectedId?: string | null;
		authByEndpoint?: ReadonlyMap<string, string>;
	},
): string[] {
	const lines: string[] = [];
	if (options?.error) {
		lines.push(formatRuntimeResolutionDiagnostic(options.error));
		lines.push("");
	}
	if (statuses.length === 0) {
		lines.push("no targets configured (run clio configure)");
	} else {
		for (const status of statuses) {
			const marker = options?.selectedId === status.endpoint.id ? "▸" : " ";
			lines.push(`${marker}${formatHeaderRow(status)}`);
			lines.push(formatLocationRow(status));
			lines.push(formatHealthRow(status));
			lines.push(formatAuthRow(options?.authByEndpoint?.get(status.endpoint.id) ?? "-"));
			lines.push(formatCapabilitiesRow(status.capabilities));
			lines.push(formatReasonRow(status));
			lines.push(formatDiscoveredRow(status));
			lines.push("");
		}
	}
	return lines;
}

class ProvidersOverlayView implements Component {
	constructor(
		private getState: () => {
			statuses: ReadonlyArray<EndpointStatus>;
			error: RuntimeResolutionDiagnostic | null;
			selectedId: string | null;
			authByEndpoint: ReadonlyMap<string, string>;
		},
	) {}

	render(_width: number): string[] {
		const { statuses, error, selectedId, authByEndpoint } = this.getState();
		return formatProvidersOverlayBodyLines(statuses, {
			error,
			selectedId,
			authByEndpoint,
		});
	}

	invalidate(): void {}
}

export interface OpenProvidersOverlayOptions {
	onComplete?: () => void;
	bus?: SafeEventBus;
}

/**
 * Mount a read-only providers overlay. Runs the live probe sweep async,
 * subscribes to ProviderHealth bus events for incremental updates, and
 * handles 'r' / 'R' hotkeys to re-probe single endpoints or all of them.
 */
export function openProvidersOverlay(
	tui: TUI,
	providers: ProvidersContract,
	options?: OpenProvidersOverlayOptions,
): OverlayHandle {
	const lifecycle = new AbortController();
	let statuses: ReadonlyArray<EndpointStatus> = providers.list();
	let error: RuntimeResolutionDiagnostic | null = null;
	let selectedId: string | null = statuses[0]?.endpoint.id ?? null;
	const buildAuthMap = (): ReadonlyMap<string, string> => {
		const out = new Map<string, string>();
		for (const status of statuses) {
			if (!status.runtime) {
				out.set(status.endpoint.id, "unknown-runtime");
				continue;
			}
			if (status.runtime.auth !== "api-key" && status.runtime.auth !== "oauth") {
				out.set(status.endpoint.id, status.runtime.auth);
				continue;
			}
			const auth = providers.auth.statusForTarget(status.endpoint, status.runtime);
			if (!auth.available) {
				out.set(status.endpoint.id, "disconnected");
				continue;
			}
			if (auth.source === "environment") {
				out.set(status.endpoint.id, auth.detail ? `env:${auth.detail}` : "environment");
				continue;
			}
			out.set(status.endpoint.id, auth.source);
		}
		return out;
	};
	let authByEndpoint = buildAuthMap();

	const view = new ProvidersOverlayView(() => ({ statuses, error, selectedId, authByEndpoint }));
	const keys: ProvidersOverlayKeys = {
		nextSelection: (direction) => {
			if (statuses.length === 0) return;
			const idx = statuses.findIndex((s) => s.endpoint.id === selectedId);
			if (idx === -1) {
				selectedId = statuses[0]?.endpoint.id ?? null;
				return;
			}
			const len = statuses.length;
			const nextIdx = (idx + (direction === "down" ? 1 : len - 1)) % len;
			const picked = statuses[nextIdx];
			if (picked) selectedId = picked.endpoint.id;
		},
		probeSelected: () => {
			if (lifecycle.signal.aborted) return;
			if (!selectedId) return;
			void (async () => {
				try {
					await providers.probeEndpoint(selectedId as string);
				} catch (err) {
					error = probeDiagnostic(err);
				}
				statuses = providers.list();
				tui.requestRender();
			})();
		},
		probeAll: () => {
			if (lifecycle.signal.aborted) return;
			void (async () => {
				try {
					await providers.probeAllLive();
				} catch (err) {
					error = probeDiagnostic(err);
				}
				statuses = providers.list();
				tui.requestRender();
			})();
		},
	};
	const box = new FocusBox(view, {
		x: 0,
		onInput: (data) => {
			if (data === "j" || matchesKey(data, "down")) {
				keys.nextSelection("down");
				view.invalidate();
				return;
			}
			if (data === "k" || matchesKey(data, "up")) {
				keys.nextSelection("up");
				view.invalidate();
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
		footerHint: HINT,
	});

	const unsubscribeHealth = options?.bus?.on(BusChannels.ProviderHealth, () => {
		if (lifecycle.signal.aborted) return;
		statuses = providers.list();
		authByEndpoint = buildAuthMap();
		tui.requestRender();
	});

	const finalize = (nextError: RuntimeResolutionDiagnostic | null): void => {
		if (lifecycle.signal.aborted) return;
		loader.stop();
		box.clear();
		statuses = providers.list();
		authByEndpoint = buildAuthMap();
		error = nextError;
		if (selectedId && !statuses.some((s) => s.endpoint.id === selectedId)) {
			selectedId = statuses[0]?.endpoint.id ?? null;
		}
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
	probeSelected(): void;
	probeAll(): void;
}
