import type { ProviderEndpointEntry, ProviderListEntry, ProvidersContract } from "../domains/providers/contract.js";
import { Box, Loader, type OverlayHandle, type TUI, Text } from "../engine/tui.js";

const CONTENT_WIDTH = 70;
const INNER_WIDTH = CONTENT_WIDTH + 2;
const TITLE = "─ Providers ";
const HINT = "[Esc] close";

export const PROVIDERS_OVERLAY_WIDTH = INNER_WIDTH + 2;

const IDENTITY = (s: string): string => s;

function padContent(text: string): string {
	return `│ ${text.padEnd(CONTENT_WIDTH)} │`;
}

function topBorder(): string {
	return `┌${TITLE.padEnd(INNER_WIDTH, "─")}┐`;
}

function bottomBorder(): string {
	return `└${"─".repeat(INNER_WIDTH)}┘`;
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

function truncateContent(line: string): string {
	if (line.length <= CONTENT_WIDTH) return line;
	if (CONTENT_WIDTH <= 3) return line.slice(0, CONTENT_WIDTH);
	return `${line.slice(0, CONTENT_WIDTH - 3)}...`;
}

export function formatProvidersOverlayLines(
	entries: ReadonlyArray<ProviderListEntry>,
	options?: { error?: string | null },
): string[] {
	const lines: string[] = [topBorder()];
	if (options?.error) {
		lines.push(padContent(truncateContent(`probe error: ${options.error}`)));
		lines.push(padContent(""));
	}
	if (entries.length === 0) {
		lines.push(padContent("no providers configured"));
	} else {
		for (const entry of entries) {
			if (entry.endpoints !== undefined) {
				lines.push(padContent(truncateContent(formatLocalHeader(entry))));
				for (const endpoint of entry.endpoints) {
					lines.push(padContent(truncateContent(formatEndpointRow(endpoint))));
				}
			} else {
				lines.push(padContent(truncateContent(formatRemoteRow(entry))));
			}
		}
	}
	lines.push(padContent(""));
	lines.push(padContent(HINT));
	lines.push(bottomBorder());
	return lines;
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

	const finalize = (lines: string[]): void => {
		if (lifecycle.signal.aborted) return;
		loader.stop();
		box.clear();
		box.addChild(new Text(lines.join("\n"), 0, 0));
		tui.requestRender();
		options?.onComplete?.();
	};

	void (async () => {
		let error: string | null = null;
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
		const entries = providers.list();
		if (lifecycle.signal.aborted) return;
		finalize(formatProvidersOverlayLines(entries, { error }));
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
