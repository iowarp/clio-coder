import type { HealthV1, QuotaStateV1, SessionTelemetryV1 } from "../core/telemetry/dto.js";
import type { RouteBreakerView } from "../domains/dispatch/contract.js";
import type { SystemOneBreakerView } from "../domains/system-one/index.js";
import type { TelemetryReadModel } from "../domains/telemetry/contract.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { matchesKey, wrapTextWithAnsi } from "../engine/tui.js";
import { buildResponsiveHint, showClioOverlayFrame } from "./overlay-frame.js";
import { routeBreakerPhrase } from "./overlays/settings.js";
import { clioTheme } from "./theme/index.js";

/**
 * `/health`: what Clio's own telemetry can vouch for right now (#434 §14). Journal writers and their losses, the
 * producer, event-loop lag, the session's transport, provider quota, route breakers and System One's engine
 * breakers. Every telemetry number is the read model's own display, and the breakers are their owners' live state,
 * all read on render from memory; nothing here reads a journal.
 */
const HEALTH_OVERLAY_WIDTH = 96;
const NOT_AVAILABLE = "not available: this session has no telemetry read model";

interface HealthData {
	health: HealthV1 | null;
	transport: SessionTelemetryV1["transport"] | undefined;
	quota: QuotaStateV1 | null;
	breakers: ReadonlyArray<RouteBreakerView>;
	/** Null when this process has no System One. */
	systemOne: ReadonlyArray<SystemOneBreakerView> | null;
}

/** One System One breaker's state, worded as the route breakers are. */
function systemOneBreakerPhrase(breaker: SystemOneBreakerView): string {
	const timeouts = `${breaker.failures} consecutive timeout${breaker.failures === 1 ? "" : "s"}`;
	switch (breaker.state) {
		case "open":
			return `open ${Math.ceil(breaker.remainingMs / 1000)}s after ${timeouts}`;
		case "probing":
			return `probing after ${timeouts}`;
		case "half-open":
			return `half-open after ${timeouts}; the next call probes`;
		case "disabled":
			return `disabled for this session after ${breaker.failures} failed decisions`;
		case "closed":
			return timeouts;
	}
}

const lost = (quantity: HealthV1["journals"][number]["dropped"]) =>
	quantity.fact.kind === "measured" && quantity.fact.value > 0;

/** The overlay's lines, from data read once per frame. */
function healthLines(data: HealthData): string[] {
	const theme = clioTheme();
	const heading = (text: string) => theme.style("sectionHeading", text, { bold: true });
	const note = (text: string) => theme.fg("annotation", text);
	const unit = (label: string, display: string, alarm = false) =>
		`${theme.fg("fieldName", label)} ${theme.fg(alarm ? "warning" : "counter", display)}`;
	const units = (parts: string[]) => `  ${parts.join(theme.fg("annotation", " · "))}`;
	const lines: string[] = [];

	lines.push(heading("Journals"));
	const health = data.health;
	if (!health) lines.push(note(`  ${NOT_AVAILABLE}`));
	else if (health.journals.length === 0) lines.push(note("  no journal writer is open in this process"));
	else
		for (const journal of health.journals) {
			lines.push(`  ${theme.fg("footerIdentity", journal.owner.replace(":", " "))}`);
			lines.push(
				units([
					unit("persisted", journal.persisted.display),
					unit("queued", journal.queueDepth.display),
					unit("dropped", journal.dropped.display, lost(journal.dropped)),
					unit("invalid", journal.invalid.display, lost(journal.invalid)),
					unit("write errors", journal.writeErrors.display, lost(journal.writeErrors)),
					unit("filtered", journal.filtered.display),
				]),
			);
		}
	if (health) {
		lines.push(
			"",
			heading("Producer"),
			units([
				unit("unowned records", health.producer.unownedRecords.display, lost(health.producer.unownedRecords)),
				unit("sink failures", health.producer.sinkFailures.display, lost(health.producer.sinkFailures)),
			]),
			"",
			heading("Event loop"),
			units([
				unit("lag p50", health.loopLag.p50.display),
				unit("p99", health.loopLag.p99.display),
				unit("max", health.loopLag.max.display),
			]),
		);
		if (health.loopLag.max.fact.kind === "unknown") lines.push(note("  unknown until a health window is recorded"));
	}

	lines.push("", heading("Session transport"));
	const transport = data.transport;
	if (transport === undefined) lines.push(note(`  ${NOT_AVAILABLE}`));
	else if (transport === null) lines.push(note("  no main call has settled yet"));
	else {
		lines.push(
			units([
				unit("kind", transport.kind),
				unit("continuation", transport.continuation.display),
				unit("pinned to SSE", transport.sessionPinnedToSse.display),
				...(transport.pinReason ? [unit("because", transport.pinReason.replaceAll("_", " "))] : []),
			]),
			units([
				unit("websocket failures", transport.websocketFailures.display),
				unit("SSE fallbacks", transport.sseFallbacks.display),
				...(transport.recovery
					? [unit("recovery", `${transport.recovery.action.replaceAll("_", " ")} ${transport.recovery.outcome}`)]
					: []),
			]),
			note(`  as of the main call settled at ${transport.at}`),
		);
	}

	lines.push("", heading("Quota"));
	const providers = data.quota?.providers ?? [];
	if (!data.quota) lines.push(note(`  ${NOT_AVAILABLE}`));
	else if (providers.length === 0) lines.push(note("  no provider has reported quota to this process or session"));
	for (const provider of providers) {
		const seen = provider.observedAt ? `observed ${provider.observedAt}` : "observed at an unknown time";
		lines.push(
			`  ${theme.fg("footerIdentity", provider.provider)} ${note(`${provider.source.replaceAll("-", " ")} · ${seen}`)}${
				provider.stale ? ` ${theme.fg("warning", "stale")}` : ""
			}`,
		);
		for (const window of provider.windows)
			lines.push(
				units([
					unit(window.label ?? window.key, `${window.usedPct.display} used`),
					...(window.resetsAt ? [note(`resets ${window.resetsAt}`)] : []),
				]),
			);
	}

	lines.push("", heading("Route breakers"));
	if (data.breakers.length === 0) lines.push(note("  no route breaker is open or counting failures"));
	for (const route of data.breakers)
		lines.push(
			`  ${theme.fg("footerIdentity", route.targetId)} ${theme.fg(route.state === "closed" ? "counter" : "warning", routeBreakerPhrase(route))}`,
		);

	lines.push("", heading("System One breakers"));
	if (data.systemOne === null) lines.push(note("  not available: this process has no System One"));
	else if (data.systemOne.length === 0) lines.push(note("  no engine breaker is open or counting timeouts"));
	for (const breaker of data.systemOne ?? [])
		lines.push(
			`  ${theme.fg("footerIdentity", breaker.engine)} ${note(`${breaker.site}${breaker.moment ? `/${breaker.moment}` : ""}`)} ${theme.fg(
				breaker.state === "closed" ? "counter" : "warning",
				systemOneBreakerPhrase(breaker),
			)}`,
		);
	return lines;
}

class HealthOverlayBody implements Component {
	private offset = 0;
	private height = 20;
	private pageHeight = 18;
	private lineCount = 0;

	constructor(
		private readonly getData: () => HealthData,
		private readonly requestRender: () => void,
	) {}

	setHeight(rows: number): void {
		// The dock reports its own viewport: body rows plus the two rails.
		this.height = Math.max(1, rows - 2);
	}

	handleInput(data: string): void {
		let offset = this.offset;
		if (matchesKey(data, "up")) offset--;
		else if (matchesKey(data, "down")) offset++;
		else if (matchesKey(data, "pageUp")) offset -= this.pageHeight;
		else if (matchesKey(data, "pageDown")) offset += this.pageHeight;
		else if (matchesKey(data, "home") || matchesKey(data, "ctrl+home")) offset = 0;
		else if (matchesKey(data, "end") || matchesKey(data, "ctrl+end")) offset = this.lineCount;
		else return;
		this.offset = Math.max(0, Math.min(offset, this.lineCount - this.pageHeight));
		this.requestRender();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, Math.floor(width));
		const lines = healthLines(this.getData()).flatMap((line) => wrapTextWithAnsi(line, contentWidth));
		this.lineCount = lines.length;
		// One row stays free for the `n–m / N` indicator a scrolled page carries.
		this.pageHeight = Math.max(1, this.height - 1);
		this.offset = Math.max(0, Math.min(this.offset, lines.length - this.pageHeight));
		const visible = lines.slice(this.offset, this.offset + this.pageHeight);
		if (lines.length > this.pageHeight)
			visible.push(
				clioTheme().fg(
					"annotation",
					`${this.offset + 1}–${Math.min(lines.length, this.offset + this.pageHeight)} / ${lines.length}`,
				),
			);
		return visible;
	}

	invalidate(): void {}
}

export interface OpenHealthOverlayOptions {
	getBreakers?: () => ReadonlyArray<RouteBreakerView>;
	/** Absent when this process has no System One. */
	getSystemOneBreakers?: () => ReadonlyArray<SystemOneBreakerView>;
}

/** Mount the read-only health overlay; it repaints on the read model's coalesced health, quota and session updates. */
export function openHealthOverlay(
	tui: TUI,
	telemetry: TelemetryReadModel | undefined,
	options?: OpenHealthOverlayOptions,
): OverlayHandle {
	const body = new HealthOverlayBody(
		() => ({
			health: telemetry?.health() ?? null,
			transport: telemetry ? (telemetry.live()?.session().transport ?? null) : undefined,
			quota: telemetry?.quota() ?? null,
			breakers: options?.getBreakers?.() ?? [],
			systemOne: options?.getSystemOneBreakers?.() ?? null,
		}),
		() => tui.requestRender(),
	);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: HEALTH_OVERLAY_WIDTH,
		markerId: "health",
		title: "Health",
		footerHint: buildResponsiveHint([
			{ key: "↑↓", verb: "scroll", critical: true },
			{ key: "PgUp/PgDn", verb: "page" },
		]),
		visible: (_width, height) => {
			body.setHeight(height);
			return true;
		},
	});
	const offs = telemetry
		? (["health", "quota", "session"] as const).map((topic) => telemetry.subscribe(topic, () => tui.requestRender()))
		: [];
	return {
		...handle,
		hide(): void {
			for (const off of offs) off();
			handle.hide();
		},
	};
}
