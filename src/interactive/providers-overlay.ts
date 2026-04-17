import type { ProviderEndpointEntry, ProviderListEntry, ProvidersContract } from "../domains/providers/contract.js";
import { Box, Loader, type Component, type OverlayHandle, type TUI, truncateToWidth } from "../engine/tui.js";

const DEFAULT_CONTENT_WIDTH = 70;
const TITLE = "─ Providers ";
const HINT = "[Esc] close";

export const PROVIDERS_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

const IDENTITY = (s: string): string => s;

function padContent(text: string, contentWidth: number): string {
	return `│ ${truncateToWidth(text, contentWidth, "...", true)} │`;
}

function topBorder(contentWidth: number): string {
	const innerWidth = contentWidth + 2;
	if (innerWidth <= TITLE.length) {
		return `┌${"─".repeat(innerWidth)}┐`;
	}
	return `┌${TITLE.padEnd(innerWidth, "─")}┐`;
}

function bottomBorder(contentWidth: number): string {
	return `└${"─".repeat(contentWidth + 2)}┘`;
}

function statusTag(entry: ProviderListEntry): "ok" | "off" | "unknown" {
	if (entry.health.status === "healthy" || entry.health.status === "degraded") return "ok";
	if (entry.health.status === "down") return "off";
	return "unknown";
}

function formatRemoteRow(entry: ProviderListEntry): string {
	const id = entry.id.padEnd(16);
	const tier = entry.tier.padEnd(7);
	const status = statusTag(entry).padEnd(8);
	const note = entry.available ? entry.displayName : `${entry.displayName} (${entry.reason})`;
	return `  ${id} ${tier} ${status} ${note}`;
}

function formatLocalHeader(entry: ProviderListEntry): string {
	const endpoints = entry.endpoints ?? [];
	const total = endpoints.length;
	const healthy = endpoints.filter((ep) => ep.probe?.ok === true).length;
	const unreachable = endpoints.filter((ep) => ep.probe && ep.probe.ok === false).length;
	const summary =
		total === 0
			? `${entry.id} (0 endpoints)`
			: `${entry.id} (${total} endpoint${total === 1 ? "" : "s"}, ${healthy} healthy${
					unreachable > 0 ? `, ${unreachable} unreachable` : ""
				})`;
	return `  ${summary}`;
}

function formatEndpointRow(endpoint: ProviderEndpointEntry): string {
	const name = endpoint.name.padEnd(12);
	const url = endpoint.url.padEnd(28);
	if (!endpoint.probe) {
		return `    ${name} ${url} not probed`;
	}
	if (endpoint.probe.ok) {
		const latency = endpoint.probe.latencyMs !== undefined ? `${endpoint.probe.latencyMs}ms` : "-";
		const modelCount = endpoint.probe.models?.length ?? 0;
		return `    ${name} ${url} ok ${latency} ${modelCount} models`;
	}
	return `    ${name} ${url} off ${endpoint.probe.error ?? "unreachable"}`;
}

function resolveContentWidth(contentWidth?: number): number {
	return Math.max(1, contentWidth ?? DEFAULT_CONTENT_WIDTH);
}

export function formatProvidersOverlayLines(
	entries: ReadonlyArray<ProviderListEntry>,
	options?: { error?: string | null; contentWidth?: number },
): string[] {
	const contentWidth = resolveContentWidth(options?.contentWidth);
	const lines: string[] = [topBorder(contentWidth)];
	if (options?.error) {
		lines.push(padContent(`probe error: ${options.error}`, contentWidth));
		lines.push(padContent("", contentWidth));
	}
	if (entries.length === 0) {
		lines.push(padContent("no providers configured", contentWidth));
	} else {
		for (const entry of entries) {
			if (entry.endpoints !== undefined) {
				lines.push(padContent(formatLocalHeader(entry), contentWidth));
				for (const endpoint of entry.endpoints) {
					lines.push(padContent(formatEndpointRow(endpoint), contentWidth));
				}
			} else {
				lines.push(padContent(formatRemoteRow(entry), contentWidth));
			}
		}
	}
	lines.push(padContent("", contentWidth));
	lines.push(padContent(HINT, contentWidth));
	lines.push(bottomBorder(contentWidth));
	return lines;
}

class ProvidersOverlayView implements Component {
	constructor(
		private readonly entries: ReadonlyArray<ProviderListEntry>,
		private readonly error: string | null,
	) {}

	render(width: number): string[] {
		if (width <= 4) {
			return [truncateToWidth("Providers", width, "", true)];
		}
		return formatProvidersOverlayLines(this.entries, {
			error: this.error,
			contentWidth: width - 4,
		});
	}

	invalidate(): void {}
}

export interface OpenProvidersOverlayOptions {
	onComplete?: () => void;
}

/**
 * Mount a read-only providers overlay. Runs the live probe sweeps async, swaps
 * the Loader for the rendered list when they resolve, and returns the overlay
 * handle so the caller can dismiss it on Esc.
 */
export function openProvidersOverlay(
	tui: TUI,
	providers: ProvidersContract,
	options?: OpenProvidersOverlayOptions,
): OverlayHandle {
	const box = new Box(0, 0);
	const loader = new Loader(tui, IDENTITY, IDENTITY, "Probing providers...");
	box.addChild(loader);
	const lifecycle = new AbortController();
	const handle = tui.showOverlay(box, {
		anchor: "center",
		width: PROVIDERS_OVERLAY_WIDTH,
	});

	const finalize = (entries: ReadonlyArray<ProviderListEntry>, error: string | null): void => {
		if (lifecycle.signal.aborted) return;
		loader.stop();
		box.clear();
		box.addChild(new ProvidersOverlayView(entries, error));
		tui.requestRender();
		options?.onComplete?.();
	};

	void (async () => {
		let error: string | null = null;
		let entries: ReadonlyArray<ProviderListEntry> = [];
		try {
			await providers.probeAllLive();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		if (error === null) {
			try {
				await providers.probeEndpoints();
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		}
		entries = providers.list();
		if (lifecycle.signal.aborted) return;
		finalize(entries, error);
	})();

	return {
		...handle,
		hide(): void {
			if (!lifecycle.signal.aborted) {
				lifecycle.abort();
			}
			loader.stop();
			handle.hide();
		},
	};
}
