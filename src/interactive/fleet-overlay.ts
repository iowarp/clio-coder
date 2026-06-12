import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract, DispatchSnapshot } from "../domains/dispatch/contract.js";
import { type OverlayHandle, Text, type TUI, truncateToWidth } from "../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";

const DEFAULT_CONTENT_WIDTH = 84;
const REFRESH_MS = 1000;

export const FLEET_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

function fitLeft(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

function fitRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${" ".repeat(Math.max(0, width - clipped.length))}${clipped}`;
}

function shortId(runId: string): string {
	return runId.length <= 10 ? runId : runId.slice(0, 10);
}

function formatSeconds(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function formatRuntimeSeconds(seconds: number): string {
	return formatSeconds(seconds * 1000);
}

function formatTokens(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatUsd(value: number): string {
	return `$${Math.max(0, value).toFixed(4)}`;
}

function divider(width: number): string {
	return "─".repeat(width);
}

function runningHeader(): string {
	return [
		fitLeft("run", 10),
		fitLeft("agent", 12),
		fitLeft("rt", 5),
		fitLeft("hb", 6),
		fitLeft("phase", 11),
		fitRight("try", 3),
		fitRight("dep", 3),
		fitRight("age", 7),
		fitRight("tokens", 8),
		fitRight("cost", 9),
	].join(" ");
}

function retryHeader(): string {
	return [
		fitLeft("source", 10),
		fitLeft("agent", 12),
		fitRight("try", 3),
		fitLeft("due", 20),
		fitLeft("reason", 32),
	].join(" ");
}

function runningRow(row: DispatchSnapshot["running"][number], width: number): string {
	const line = [
		fitLeft(shortId(row.runId), 10),
		fitLeft(row.agentId, 12),
		fitLeft(row.runtimeKind, 5),
		fitLeft(row.heartbeat, 6),
		fitLeft(row.outcomePhase, 11),
		fitRight(String(row.lineage.attempt), 3),
		fitRight(String(row.lineage.depth), 3),
		fitRight(formatSeconds(row.elapsedMs), 7),
		fitRight(formatTokens(row.tokens.total), 8),
		fitRight(formatUsd(row.costUsd), 9),
	].join(" ");
	return truncateToWidth(line, width, "", true);
}

function retryRow(row: DispatchSnapshot["retrying"][number], width: number): string {
	const line = [
		fitLeft(shortId(row.runId), 10),
		fitLeft(row.agentId, 12),
		fitRight(String(row.attempt), 3),
		fitLeft(row.dueAt, 20),
		fitLeft(row.reason, 32),
	].join(" ");
	return truncateToWidth(line, width, "", true);
}

function totalsLine(totals: DispatchSnapshot["totals"]): string {
	return `input=${formatTokens(totals.inputTokens)} output=${formatTokens(totals.outputTokens)} total=${formatTokens(
		totals.totalTokens,
	)} cost=${formatUsd(totals.costUsd)} runtime=${formatRuntimeSeconds(totals.runtimeSeconds)}`;
}

export function formatFleetOverlayBodyLines(
	snapshot: DispatchSnapshot,
	contentWidth = DEFAULT_CONTENT_WIDTH,
): string[] {
	const lines: string[] = [];
	lines.push(`generated ${snapshot.generatedAt}`);
	lines.push(divider(contentWidth));
	lines.push(`running (${snapshot.running.length})`);
	if (snapshot.running.length === 0) {
		lines.push("  none in this TUI process");
	} else {
		lines.push(runningHeader());
		for (const row of snapshot.running) lines.push(runningRow(row, contentWidth));
	}
	lines.push("");
	lines.push(`retrying (${snapshot.retrying.length})`);
	if (snapshot.retrying.length === 0) {
		lines.push("  none in this TUI process");
	} else {
		lines.push(retryHeader());
		for (const row of snapshot.retrying) lines.push(retryRow(row, contentWidth));
	}
	lines.push("");
	lines.push("totals");
	lines.push(`  ${totalsLine(snapshot.totals)}`);
	if (snapshot.running.length === 0 && snapshot.retrying.length === 0) {
		lines.push("");
		lines.push("No in-process dispatches are active.");
		lines.push("Cross-process live retry state is not attached to the TUI; use `clio fleet status`");
		lines.push("for durable ledger-backed running rows from other Clio processes.");
	}
	return lines;
}

function renderSnapshot(dispatch: DispatchContract): string {
	try {
		return formatFleetOverlayBodyLines(dispatch.snapshot(), DEFAULT_CONTENT_WIDTH).join("\n");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [`fleet snapshot unavailable`, "", message].join("\n");
	}
}

export interface OpenFleetOverlayOptions {
	bus?: SafeEventBus;
}

/** Mount the read-only `/fleet` overlay backed by in-process DispatchContract.snapshot(). */
export function openFleetOverlay(
	tui: TUI,
	dispatch: DispatchContract,
	options?: OpenFleetOverlayOptions,
): OverlayHandle {
	const text = new Text(renderSnapshot(dispatch), 0, 0);
	const handle = showClioOverlayFrame(tui, text, {
		anchor: "center",
		width: FLEET_OVERLAY_WIDTH,
		title: "Fleet status",
		footerHint: buildHint("browse", []),
	});

	const refresh = (): void => {
		text.setText(renderSnapshot(dispatch));
		text.invalidate();
		tui.requestRender();
	};

	const timer = setInterval(refresh, REFRESH_MS);
	timer.unref?.();
	const unsubscribes: Array<() => void> = [];
	if (options?.bus) {
		unsubscribes.push(options.bus.on(BusChannels.DispatchStarted, refresh));
		unsubscribes.push(options.bus.on(BusChannels.DispatchProgress, refresh));
		unsubscribes.push(options.bus.on(BusChannels.DispatchCompleted, refresh));
		unsubscribes.push(options.bus.on(BusChannels.DispatchFailed, refresh));
	}

	return {
		...handle,
		hide(): void {
			clearInterval(timer);
			for (const off of unsubscribes) off();
			handle.hide();
		},
	};
}
