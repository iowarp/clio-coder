import type { HealthV1, QuotaStateV1, SessionTelemetryV1 } from "../core/telemetry/dto.js";
import type { RouteBreakerView } from "../domains/dispatch/contract.js";
import type { SystemOneBreakerView } from "../domains/system-one/index.js";
import type { TelemetryReadModel } from "../domains/telemetry/contract.js";
import type { OverlayHandle, TUI } from "../engine/tui.js";
import { buildResponsiveHint, ScrollingBody, showClioOverlayFrame } from "./overlay-frame.js";
import { routeBreakerPhrase } from "./overlays/settings.js";
import { quotaAccountRows } from "./quota-view.js";
import {
	chipRow,
	clioTheme,
	emptyState,
	factRows,
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
			return `paused ${Math.ceil(breaker.remainingMs / 1000)}s after ${timeouts}`;
		case "probing":
			return `probing after ${timeouts}`;
		case "half-open":
			return `recovering after ${timeouts}; the next call tests it`;
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
			`${statusChip(theme, breaker.state === "closed" ? "ok" : "warning")} ${theme.fg("footerIdentity", breaker.engine)} ${theme.fg(
				breaker.state === "closed" ? "counter" : "warning",
				systemOneBreakerPhrase(breaker),
			)}`,
		);
	return lines;
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
	const body = new ScrollingBody(
		(width) =>
			healthLines(
				{
					health: telemetry?.health() ?? null,
					transport: telemetry ? (telemetry.live()?.session().transport ?? null) : undefined,
					quota: telemetry?.quota() ?? null,
					breakers: options?.getBreakers?.() ?? [],
					systemOne: options?.getSystemOneBreakers?.() ?? null,
				},
				width,
			),
		() => tui.requestRender(),
		18,
	);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: HEALTH_OVERLAY_WIDTH,
		markerId: "health",
		title: "Health",
		// The scroll keys are named only while they move something.
		footerHint: (innerWidth) =>
			buildResponsiveHint(
				body.overflows()
					? [
							{ key: "↑↓", verb: "scroll", critical: true },
							{ key: "PgUp/PgDn", verb: "page" },
						]
					: [],
			)(innerWidth),
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
