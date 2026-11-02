import type { HealthV1, QuotaStateV1, SessionTelemetryV1 } from "../core/telemetry/dto.js";
import type { RouteBreakerView } from "../domains/dispatch/contract.js";
import type { SystemOneBreakerView } from "../domains/system-one/index.js";
import type { TelemetryReadModel } from "../domains/telemetry/contract.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { matchesKey, wrapTextWithAnsi } from "../engine/tui.js";
import {
	buildResponsiveHint,
	createCachedBody,
	type RowBudgetedBody,
	showClioOverlayFrame,
	windowRows,
} from "./overlay-frame.js";
import { routeBreakerPhrase } from "./overlays/settings.js";
import { quotaAccountRows } from "./quota-view.js";
import {
	chipRow,
	clioTheme,
	emptyState,
	factRows,
	positionRow,
	sectionRule,
	statusChip,
	type TableCell,
	tableRows,
} from "./theme/index.js";

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

/** A journal or producer counter: the read model's display beside its fact. */
type LiveCount = HealthV1["journals"][number]["dropped"];

const lost = (quantity: LiveCount) => quantity.fact.kind === "measured" && quantity.fact.value > 0;

/** The overlay's lines, from data read once per frame: a rule per region, a table where the numbers line up. */
function healthLines(data: HealthData, width: number): string[] {
	const theme = clioTheme();
	const unit = (label: string, display: string, alarm = false) =>
		`${theme.fg("fieldName", label)} ${theme.fg(alarm ? "warning" : "counter", display)}`;
	const loss = (quantity: LiveCount): TableCell => ({
		text: quantity.display,
		...(lost(quantity) ? { tone: "warning" } : {}),
	});
	const missing = (message: string) => emptyState(theme, message, width);
	const lines: string[] = [];

	const health = data.health;
	lines.push(
		sectionRule(theme, width, "Journals", {
			...(health ? { meta: `${health.journals.length} writer${health.journals.length === 1 ? "" : "s"}` } : {}),
		}),
	);
	if (!health) lines.push(...missing(NOT_AVAILABLE));
	else if (health.journals.length === 0) lines.push(...missing("no journal writer is open in this process"));
	else
		lines.push(
			...tableRows(
				theme,
				{
					header: true,
					columns: [
						{ label: "owner", priority: 10 },
						{ label: "persisted", align: "right", priority: 8 },
						{ label: "queued", align: "right", priority: 7 },
						{ label: "dropped", align: "right", priority: 9 },
						{ label: "invalid", align: "right", priority: 6 },
						{ label: "write errors", align: "right", priority: 6 },
						{ label: "filtered", align: "right", priority: 3 },
					],
					rows: health.journals.map((journal) => [
						theme.fg("footerIdentity", journal.owner.replace(":", " ")),
						journal.persisted.display,
						journal.queueDepth.display,
						loss(journal.dropped),
						loss(journal.invalid),
						loss(journal.writeErrors),
						journal.filtered.display,
					]),
				},
				width,
			),
		);
	if (health) {
		lines.push(
			sectionRule(theme, width, "Producer"),
			chipRow(
				theme,
				[
					unit("unowned records", health.producer.unownedRecords.display, lost(health.producer.unownedRecords)),
					unit("sink failures", health.producer.sinkFailures.display, lost(health.producer.sinkFailures)),
				],
				width,
			),
			sectionRule(theme, width, "Event loop"),
			chipRow(
				theme,
				[
					unit("lag p50", health.loopLag.p50.display),
					unit("p99", health.loopLag.p99.display),
					unit("max", health.loopLag.max.display),
				],
				width,
			),
		);
		if (health.loopLag.max.fact.kind === "unknown")
			lines.push(theme.fg("annotation", "unknown until a health window is recorded"));
	}

	lines.push(sectionRule(theme, width, "Session transport"));
	const transport = data.transport;
	if (transport === undefined) lines.push(...missing(NOT_AVAILABLE));
	else if (transport === null) lines.push(...missing("no main call has settled yet"));
	else {
		lines.push(
			...factRows(
				theme,
				[
					{ label: "kind", value: transport.kind },
					{ label: "continuation", value: transport.continuation.display },
					{ label: "pinned to SSE", value: transport.sessionPinnedToSse.display },
					...(transport.pinReason ? [{ label: "because", value: transport.pinReason.replaceAll("_", " ") }] : []),
					{ label: "websocket failures", value: transport.websocketFailures.display },
					{ label: "SSE fallbacks", value: transport.sseFallbacks.display },
					...(transport.recovery
						? [
								{ label: "recovery", value: `${transport.recovery.action.replaceAll("_", " ")} ${transport.recovery.outcome}` },
							]
						: []),
				],
				width,
			),
			theme.fg("annotation", `as of the main call settled at ${transport.at}`),
		);
	}

	lines.push(sectionRule(theme, width, "Quota"));
	const providers = data.quota?.providers ?? [];
	if (!data.quota) lines.push(...missing(NOT_AVAILABLE));
	else if (providers.length === 0) lines.push(...missing("no provider has reported quota to this process or session"));
	else lines.push(...quotaAccountRows(providers, width));

	lines.push(sectionRule(theme, width, "Route breakers"));
	if (data.breakers.length === 0) lines.push(...missing("no route breaker is open or counting failures"));
	for (const route of data.breakers)
		lines.push(
			`${statusChip(theme, route.state === "closed" ? "ok" : "warning")} ${theme.fg("footerIdentity", route.targetId)} ${theme.fg(route.state === "closed" ? "counter" : "warning", routeBreakerPhrase(route))}`,
		);

	lines.push(sectionRule(theme, width, "System One breakers"));
	if (data.systemOne === null) lines.push(...missing("not available: this process has no System One"));
	else if (data.systemOne.length === 0) lines.push(...missing("no engine breaker is open or counting timeouts"));
	for (const breaker of data.systemOne ?? [])
		lines.push(
			`${statusChip(theme, breaker.state === "closed" ? "ok" : "warning")} ${theme.fg("footerIdentity", breaker.engine)} ${theme.fg("annotation", `${breaker.site}${breaker.moment ? `/${breaker.moment}` : ""}`)} ${theme.fg(
				breaker.state === "closed" ? "counter" : "warning",
				systemOneBreakerPhrase(breaker),
			)}`,
		);
	return lines;
}

/**
 * The scrolling body. The lines are cached on the data revision and the
 * width, so the one-second repaints a read model's updates ask for rebuild
 * nothing while the numbers hold; the window over them moves with the keys.
 */
class HealthOverlayBody implements Component, RowBudgetedBody {
	private offset = 0;
	private rows = 0;
	private readonly lines;
	private memo: { all: string[]; offset: number; rows: number; visible: string[] } | null = null;

	constructor(
		getData: () => HealthData,
		private readonly requestRender: () => void,
	) {
		this.lines = createCachedBody((width) =>
			healthLines(getData(), width).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))),
		);
	}

	/** The data behind the lines changed; the next render rebuilds them. */
	touch(): void {
		this.lines.touch();
	}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	private pageHeight(): number {
		// One row stays free for the position a scrolled page carries.
		return Math.max(1, (this.rows > 0 ? this.rows : 18) - 1);
	}

	handleInput(data: string): void {
		const page = this.pageHeight();
		let offset = this.offset;
		if (matchesKey(data, "up")) offset--;
		else if (matchesKey(data, "down")) offset++;
		else if (matchesKey(data, "pageUp")) offset -= page;
		else if (matchesKey(data, "pageDown")) offset += page;
		else if (matchesKey(data, "home") || matchesKey(data, "ctrl+home")) offset = 0;
		else if (matchesKey(data, "end") || matchesKey(data, "ctrl+end")) offset = Number.MAX_SAFE_INTEGER;
		else return;
		this.offset = Math.max(0, offset);
		this.requestRender();
	}

	render(width: number): string[] {
		const all = this.lines.render(width);
		const page = this.pageHeight();
		const { window, start, position } = windowRows(all, this.offset, page);
		this.offset = start;
		const memo = this.memo;
		if (memo && memo.all === all && memo.offset === start && memo.rows === this.rows) return memo.visible;
		const visible = [...window];
		if (position) visible.push(positionRow(clioTheme(), { ...position, keys: ["↑↓ scroll", "PgUp/PgDn page"] }, width));
		this.memo = { all, offset: start, rows: this.rows, visible };
		return visible;
	}

	invalidate(): void {
		this.lines.invalidate();
		this.memo = null;
	}
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
	});
	// The breakers are read live and have no update topic, so a frame the
	// owner requests for any reason still sees them fresh; the read model's
	// topics mark the cached lines stale.
	const offs = telemetry
		? (["health", "quota", "session"] as const).map((topic) =>
				telemetry.subscribe(topic, () => {
					body.touch();
					tui.requestRender();
				}),
			)
		: [];
	return {
		...handle,
		hide(): void {
			for (const off of offs) off();
			handle.hide();
		},
	};
}
