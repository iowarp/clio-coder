import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract, DispatchSnapshot } from "../domains/dispatch/contract.js";
import { type Component, type OverlayHandle, type TUI, truncateToWidth, visibleWidth } from "../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";

const DEFAULT_CONTENT_WIDTH = 84;
const REFRESH_MS = 1000;

export const FLEET_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

function fitLeft(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function fitRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${clipped}`;
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

function fitContentLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "", true);
}

function runningHeader(width: number): string {
	return fitContentLine(
		[
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
		].join(" "),
		width,
	);
}

function retryHeader(width: number): string {
	return fitContentLine(
		[fitLeft("source", 10), fitLeft("agent", 12), fitRight("try", 3), fitLeft("due", 20), fitLeft("reason", 32)].join(
			" ",
		),
		width,
	);
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
	const width = Math.max(1, Math.floor(contentWidth));
	const lines: string[] = [];
	const push = (line: string): void => {
		lines.push(fitContentLine(line, width));
	};
	push(`generated ${snapshot.generatedAt}`);
	lines.push(divider(width));
	push(`running (${snapshot.running.length})`);
	if (snapshot.running.length === 0) {
		push("  none in this TUI process");
	} else {
		lines.push(runningHeader(width));
		for (const row of snapshot.running) lines.push(runningRow(row, width));
	}
	lines.push("");
	push(`retrying (${snapshot.retrying.length})`);
	if (snapshot.retrying.length === 0) {
		push("  none in this TUI process");
	} else {
		lines.push(retryHeader(width));
		for (const row of snapshot.retrying) lines.push(retryRow(row, width));
	}
	lines.push("");
	push("totals");
	push(`  ${totalsLine(snapshot.totals)}`);
	if (snapshot.running.length === 0 && snapshot.retrying.length === 0) {
		lines.push("");
		push("No in-process dispatches are active.");
		push("Cross-process live retry state is not attached to the TUI.");
		push("Use `clio fleet status` for durable ledger-backed running rows.");
		push("Rows from other Clio processes are not shown here.");
	}
	return lines;
}

function renderSnapshot(dispatch: DispatchContract, width = DEFAULT_CONTENT_WIDTH): string[] {
	try {
		return formatFleetOverlayBodyLines(dispatch.snapshot(), width);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [`fleet snapshot unavailable`, "", fitContentLine(message, width)];
	}
}

export interface OpenFleetOverlayOptions {
	bus?: SafeEventBus;
}

class FleetOverlayBody implements Component {
	constructor(private readonly dispatch: DispatchContract) {}

	render(width: number): string[] {
		return renderSnapshot(this.dispatch, Math.max(1, Math.floor(width)));
	}

	invalidate(): void {}
}

/** Mount the read-only `/fleet` overlay backed by in-process DispatchContract.snapshot(). */
export function openFleetOverlay(
	tui: TUI,
	dispatch: DispatchContract,
	options?: OpenFleetOverlayOptions,
): OverlayHandle {
	const body = new FleetOverlayBody(dispatch);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: FLEET_OVERLAY_WIDTH,
		title: "Fleet status",
		footerHint: buildHint("browse", []),
	});

	const refresh = (): void => {
		body.invalidate();
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
