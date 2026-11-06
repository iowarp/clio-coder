import { stampLocal } from "../core/format-time.js";
import type { HealthV1, QuotaStateV1, SessionTelemetryV1 } from "../core/telemetry/dto.js";
import { renderCount } from "../core/telemetry/render.js";
import type { RouteBreakerView } from "../domains/dispatch/contract.js";
import type { SystemOneBreakerView } from "../domains/system-one/index.js";
import type { TelemetryReadModel } from "../domains/telemetry/contract.js";
import { HEALTH_WINDOW_MS } from "../domains/telemetry/health-window.js";
import { type OverlayHandle, type TUI, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { buildResponsiveHint, ScrollingBody, showClioOverlayFrame } from "./overlay-frame.js";
import { routeBreakerPhrase } from "./overlays/settings.js";
import { quotaAccountRows } from "./quota-view.js";
import {
	chipRows,
	clioTheme,
	emptyState,
	factRows,
	sectionRule,
	statusChip,
	type TableCell,
	type TableSpec,
	tableColumnsFit,
	tableRows,
} from "./theme/index.js";
import { stripUsageClause, usageCoverage, usageFigure, usageGap, usageUnmeasured } from "./usage-words.js";

/**
 * `/health`: what Clio's own telemetry can vouch for right now (#434 §14). It opens on one sentence that answers
 * whether Clio is saving what it records and responding promptly, then the details behind it: each journal writer
 * and its losses, the records no writer took, event-loop lag, the session's connection, provider limits, route
 * breakers and System One's engine breakers. Every telemetry number is the read model's own display, and the
 * breakers are their owners' live state, all read on render from memory; nothing here reads a journal.
 */
const HEALTH_OVERLAY_WIDTH = 96;
/**
 * A tick that runs this late is where typing and scrolling start to feel slow (the usual 100 ms limit for a response
 * that reads as immediate), so a slowest-1% figure past it is what the summary calls slow.
 */
const SLOW_TICK_MS = 100;
/** One pause this long is noticed even when the slowest 1% is fine, so the summary names it. */
const STALL_MS = 1000;
const WINDOW_SECONDS = Math.round(HEALTH_WINDOW_MS / 1000);

interface HealthData {
	health: HealthV1 | null;
	/** The session the open view reads, so its journal reads as "this session"; null with no session yet. */
	sessionId: string | null;
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
type Journal = HealthV1["journals"][number];

const measured = (quantity: LiveCount): number => (quantity.fact.kind === "measured" ? quantity.fact.value : 0);
const lost = (quantity: LiveCount) => measured(quantity) > 0;
const records = (count: number) => `${renderCount(count)} record${count === 1 ? "" : "s"}`;

/**
 * A writer's owner in plain words, with the raw id kept apart as secondary detail. The owner is `<kind>:<id>`; a
 * reader does not know a `prc_` id, but knows this Clio, this session and its worker runs.
 */
interface OwnerName {
	label: string;
	/** Possessive form for a sentence: "this session's journal". */
	of: string;
	id: string;
}

function ownerNames(journals: ReadonlyArray<Journal>, sessionId: string | null): OwnerName[] {
	const seen = new Map<string, number>();
	const counted = (single: string, numbered: string, kind: string) => {
		// The current session is named apart, so it does not count toward numbering the others.
		const total = journals.filter(
			(journal) => journal.owner.startsWith(`${kind}:`) && journal.owner !== `session:${sessionId}`,
		).length;
		const next = (seen.get(kind) ?? 0) + 1;
		seen.set(kind, next);
		return total > 1 ? `${numbered} ${next}` : single;
	};
	return journals.map((journal) => {
		const split = journal.owner.indexOf(":");
		const kind = split < 0 ? journal.owner : journal.owner.slice(0, split);
		const id = split < 0 ? "" : journal.owner.slice(split + 1);
		if (kind === "process") return { label: "this Clio process", of: "this Clio process's", id };
		if (kind === "session" && id === sessionId) return { label: "this session", of: "this session's", id };
		const label =
			kind === "session"
				? counted("another session", "other session", kind)
				: kind === "run"
					? counted("worker run", "worker run", kind)
					: kind;
		return { label, of: `${label}'s`, id };
	});
}

/**
 * One kind of loss: its count, and what happened to those records, both after a count in a list (`3 dropped from …`)
 * and as the predicate of a sentence of its own, which some losses need a verb for (`3 records were dropped from …`).
 */
interface Loss {
	count: number;
	phrase: string;
	sentence: string;
}

function loss(count: number, phrase: string, passive = true): Loss {
	return { count, phrase, sentence: passive ? `${count === 1 ? "was" : "were"} ${phrase}` : phrase };
}

/** What a journal lost, worst first. */
function journalLosses(journal: Journal, owner: OwnerName): Loss[] {
	return [
		loss(measured(journal.dropped), `dropped from ${owner.of} journal`),
		loss(measured(journal.writeErrors), `could not be written to ${owner.of} journal`, false),
		loss(measured(journal.invalid), `rejected as malformed by ${owner.of} journal`),
	].filter((entry) => entry.count > 0);
}

/**
 * The opening sentence: whether everything Clio records is saved, and whether it is responding promptly, from the
 * same counters the details show. A loss names its count and where it happened; the counters run from when each
 * writer opened.
 */
function healthSummary(data: HealthData): { text: string; ok: boolean } {
	const health = data.health;
	if (!health)
		return {
			text: "Clio cannot check its record keeping or responsiveness: this session has no telemetry read model.",
			ok: false,
		};
	const names = ownerNames(health.journals, data.sessionId);
	const losses = [
		...health.journals.flatMap((journal, index) => {
			const owner = names[index];
			return owner ? journalLosses(journal, owner) : [];
		}),
		// The table counts these in its own `no journal open` row under `dropped`, so the verdict uses the same word.
		loss(measured(health.producer.unownedRecords), "dropped because no journal was open for them"),
		loss(measured(health.producer.sinkFailures), "refused by a journal"),
	].filter((entry) => entry.count > 0);
	const total = losses.reduce((sum, entry) => sum + entry.count, 0);
	const [only] = losses;
	const saving =
		losses.length === 0
			? health.journals.length === 0
				? "Clio has no journal open yet, so nothing is being saved."
				: "Everything Clio records is being saved."
			: losses.length === 1 && only
				? `${records(only.count)} ${only.sentence}.`
				: `Clio lost ${records(total)}: ${losses.map((entry) => `${renderCount(entry.count)} ${entry.phrase}`).join(", ")}.`;
	const lag = health.loopLag;
	const slowest = lag.p99.fact.kind === "measured" ? lag.p99.fact.value : null;
	const longest = lag.max.fact.kind === "measured" ? lag.max.fact.value : null;
	const responsive =
		slowest === null
			? `Responsiveness is not measured yet; Clio checks it every ${WINDOW_SECONDS} seconds while a session is open.`
			: slowest > SLOW_TICK_MS
				? `Clio is responding slowly: the slowest 1% of its ticks ran ${lag.p99.display} late.`
				: longest !== null && longest >= STALL_MS
					? `Responsiveness is normal apart from one pause of ${lag.max.display}.`
					: "Responsiveness is normal.";
	return {
		text: `${saving} ${responsive}`,
		ok: losses.length === 0 && health.journals.length > 0 && (slowest === null || slowest <= SLOW_TICK_MS),
	};
}

/** The connection kind in words; the provider's own term in brackets where a reader may know it. */
const TRANSPORT_KIND: Readonly<Record<string, string>> = {
	websocket: "WebSocket",
	sse: "HTTP streaming (SSE)",
	http: "HTTP",
	local: "in this process",
	subprocess: "a local program",
	unknown: "not reported",
};
const PIN_REASON: Readonly<Record<string, string>> = {
	auth_rejection: "the WebSocket sign-in was rejected",
	transport_failure: "the WebSocket connection failed",
	post_stream_or_unknown_failure: "a call failed after streaming, or for an unknown reason",
};
const RECOVERY_ACTION: Readonly<Record<string, string>> = {
	cooldown_reset: "retry after a cooldown",
	auth_reset: "sign in again",
};

/** A text fact in words: the measured value through `words`, anything else as the usage words say it. */
function textWords(
	quantity: { fact: { kind: string; value?: unknown }; display: string },
	words: (value: unknown) => string,
): string {
	return quantity.fact.kind === "measured" ? words(quantity.fact.value) : stripUsageClause(quantity.display);
}

/** The overlay's lines, from data read once per frame: the summary, then a rule per region. */
function healthLines(data: HealthData, width: number): string[] {
	const theme = clioTheme();
	const safe = Math.max(1, Math.floor(width));
	const unit = (label: string, display: string, alarm = false) =>
		`${theme.fg("fieldName", label)} ${theme.fg(alarm ? "warning" : "counter", display)}`;
	const lossCell = (quantity: LiveCount): TableCell => ({
		text: quantity.display,
		...(lost(quantity) ? { tone: "warning" } : {}),
	});
	const missing = (message: string) => emptyState(theme, message, safe);
	const note = (text: string) => wrapTextWithAnsi(theme.fg("annotation", text), safe);
	const lines: string[] = [];

	const summary = healthSummary(data);
	lines.push(
		...wrapTextWithAnsi(
			`${statusChip(theme, summary.ok ? "ok" : "warning")} ${theme.fg(summary.ok ? "body" : "warning", summary.text)}`,
			safe,
		),
		"",
	);

	// Without a read model the summary has said so once; the regions it would feed are left out rather than each
	// repeating it.
	const health = data.health;
	if (health) {
		lines.push(
			sectionRule(theme, safe, "Saving what Clio records"),
			...note(
				"Clio writes every model call and event to a journal on disk: one for this process, one for each session and worker run.",
			),
		);
		const outside = [
			unit("records a journal refused", health.producer.sinkFailures.display, lost(health.producer.sinkFailures)),
		];
		const unowned = health.producer.unownedRecords;
		if (health.journals.length === 0)
			lines.push(
				...missing("No journal is open in this process yet."),
				...chipRows(theme, [unit("dropped with no journal open", unowned.display, lost(unowned)), ...outside], safe),
			);
		else
			lines.push(
				...journalRows(
					health.journals,
					ownerNames(health.journals, data.sessionId),
					safe,
					lossCell,
					outside,
					lost(unowned) ? unowned : null,
				),
			);

		lines.push(sectionRule(theme, safe, "Responsiveness"));
		const lag = health.loopLag;
		if (lag.max.fact.kind === "unknown")
			lines.push(...missing(`Not measured yet: Clio checks every ${WINDOW_SECONDS} seconds while a session is open.`));
		else
			lines.push(
				...chipRows(
					theme,
					[
						unit("typical tick", lag.p50.display),
						unit(
							"slowest 1% of ticks",
							lag.p99.display,
							lag.p99.fact.kind === "measured" && lag.p99.fact.value > SLOW_TICK_MS,
						),
						unit("slowest tick", lag.max.display, lag.max.fact.kind === "measured" && lag.max.fact.value >= STALL_MS),
					],
					safe,
				),
				...note(
					`How late Clio's 10 ms timer ran in the latest ${WINDOW_SECONDS}-second check. Under ${SLOW_TICK_MS}ms is not noticeable.`,
				),
			);
	}

	const transport = data.transport;
	if (transport !== undefined) lines.push(sectionRule(theme, safe, "Connection to the model"));
	if (transport === null) lines.push(...missing("No reply from the model has finished yet."));
	else if (transport !== undefined) {
		const reported =
			transport.kind !== "unknown" ||
			transport.continuation.fact.kind === "measured" ||
			transport.sessionPinnedToSse.fact.kind === "measured" ||
			!usageUnmeasured(transport.websocketFailures) ||
			!usageUnmeasured(transport.sseFallbacks);
		if (!reported) lines.push(...missing("The provider reported no connection details for the last reply."));
		else
			lines.push(
				...factRows(
					theme,
					[
						{ label: "connection", value: TRANSPORT_KIND[transport.kind] ?? transport.kind },
						{
							label: "each request sends",
							value: textWords(transport.continuation, (value) =>
								value === "delta" ? "only what changed" : value === "full" ? "the whole conversation" : String(value),
							),
						},
						{
							label: "kept on SSE",
							value: textWords(transport.sessionPinnedToSse, (value) =>
								value === true ? "yes, for the rest of this session" : value === false ? "no" : String(value),
							),
						},
						...(transport.pinReason
							? [{ label: "because", value: PIN_REASON[transport.pinReason] ?? transport.pinReason.replaceAll("_", " ") }]
							: []),
						{ label: "WebSocket failures", value: usageFigure(transport.websocketFailures) },
						{ label: "fell back to SSE", value: usageFigure(transport.sseFallbacks) },
						...(transport.recovery
							? [
									{
										label: "recovery",
										value: `${RECOVERY_ACTION[transport.recovery.action] ?? transport.recovery.action.replaceAll("_", " ")}: ${transport.recovery.outcome}`,
									},
								]
							: []),
					],
					safe,
				),
			);
		// The calls that reported no transport facts are counted once here, not beside each figure (F4).
		lines.push(
			...note(
				[
					`as of the last reply, at ${stampLocal(transport.at)}`,
					usageCoverage(
						Math.max(usageGap(transport.websocketFailures), usageGap(transport.sseFallbacks)),
						"connection data",
					),
				]
					.filter((part) => part !== null)
					.join(" · "),
			),
		);
	}

	if (data.quota) {
		lines.push(sectionRule(theme, safe, "Provider limits"));
		const providers = data.quota.providers;
		if (providers.length === 0) lines.push(...missing("No provider has reported a usage limit to this session."));
		else lines.push(...quotaAccountRows(providers, safe));
	}

	lines.push(sectionRule(theme, safe, "Model routes"));
	if (data.breakers.length === 0) lines.push(...missing("No model route is paused or counting failures."));
	for (const route of data.breakers)
		lines.push(
			`${statusChip(theme, route.state === "closed" ? "ok" : "warning")} ${theme.fg("footerIdentity", route.targetId)} ${theme.fg(route.state === "closed" ? "counter" : "warning", routeBreakerPhrase(route))}`,
		);

	lines.push(sectionRule(theme, safe, "System One engines"));
	if (data.systemOne === null) lines.push(...missing("Not available: this process has no System One."));
	else if (data.systemOne.length === 0) lines.push(...missing("No System One engine is paused or counting timeouts."));
	for (const breaker of data.systemOne ?? [])
		lines.push(
			`${statusChip(theme, breaker.state === "closed" ? "ok" : "warning")} ${theme.fg("footerIdentity", breaker.engine)} ${theme.fg(
				breaker.state === "closed" ? "counter" : "warning",
				systemOneBreakerPhrase(breaker),
			)}`,
		);
	return lines;
}

/**
 * Each journal's counts: a table while every column fits whole, else one block per journal with its counts as
 * `saved 40 · waiting 0 · …` chips that wrap between counts. The table used to drop its numeric columns below
 * 80 cells and cut the process id mid-word, which left a narrow /health with names and no numbers.
 */
function journalRows(
	journals: ReadonlyArray<Journal>,
	names: ReadonlyArray<OwnerName>,
	width: number,
	lossCell: (quantity: LiveCount) => TableCell,
	/** The records a journal refused, as `label count` units, under every journal's counts. */
	outside: ReadonlyArray<string>,
	/**
	 * Records emitted while no journal was open for them. They are a loss like any other, so they get a row of their own
	 * under `dropped`: a warning verdict above a table of zeros read as two different reports (H4).
	 */
	unowned: LiveCount | null = null,
): string[] {
	const theme = clioTheme();
	const counts = (journal: Journal) =>
		[
			{ label: "saved", cell: { text: journal.persisted.display } as TableCell },
			{ label: "waiting", cell: { text: journal.queueDepth.display } as TableCell },
			{ label: "dropped", cell: lossCell(journal.dropped) },
			{ label: "rejected", cell: lossCell(journal.invalid) },
			{ label: "failed writes", cell: lossCell(journal.writeErrors) },
			{ label: "skipped", cell: { text: journal.filtered.display } as TableCell },
		] as const;
	const spec: TableSpec = {
		header: true,
		columns: [
			{ label: "journal", priority: 10 },
			...counts(journals[0] as Journal).map((count) => ({ label: count.label, align: "right" as const, priority: 5 })),
		],
		rows: [
			...journals.map((journal, index) => [
				theme.fg("footerIdentity", names[index]?.label ?? journal.owner),
				...counts(journal).map((count) => count.cell),
			]),
			...(unowned === null
				? []
				: [
						[
							theme.fg("footerIdentity", NO_JOURNAL),
							...counts(journals[0] as Journal).map((count) =>
								count.label === "dropped" ? lossCell(unowned) : ({ text: "–" } as TableCell),
							),
						],
					]),
		],
	};
	// The ids are for someone matching a journal on disk, so they come after the counts, whole or not at all.
	const idRow = (name: OwnerName | undefined): string[] => {
		if (!name || name.id.length === 0) return [];
		const inline = `${name.label} id ${name.id}`;
		if (visibleWidth(inline) <= width) return [theme.fg("annotation", inline)];
		return visibleWidth(name.id) <= width ? [theme.fg("annotation", name.id)] : [];
	};
	const explain = wrapTextWithAnsi(
		theme.fg(
			"annotation",
			"rejected means malformed; skipped means the recording mode leaves that kind out, which is not a loss.",
		),
		width,
	);
	const below = chipRows(theme, outside, width);
	if (tableColumnsFit(spec, width))
		return [...tableRows(theme, spec, width), ...below, ...explain, ...names.flatMap(idRow)];
	const lines: string[] = [];
	for (const [index, journal] of journals.entries()) {
		const name = names[index];
		const heading = theme.style("groupHeading", name?.label ?? journal.owner, { bold: true });
		const id = name && name.id.length > 0 && visibleWidth(`${name.label}  ${name.id}`) <= width ? name.id : null;
		lines.push(id === null ? heading : `${heading}  ${theme.fg("annotation", id)}`);
		lines.push(
			...chipRows(
				theme,
				counts(journal).map(
					(count) =>
						`${theme.fg("fieldName", count.label)} ${theme.fg(count.cell.tone === "warning" ? "warning" : "counter", count.cell.text)}`,
				),
				Math.max(1, width - 2),
			).map((row) => `  ${row}`),
		);
	}
	if (unowned !== null) {
		lines.push(theme.style("groupHeading", NO_JOURNAL, { bold: true }));
		lines.push(`  ${theme.fg("fieldName", "dropped")} ${theme.fg("warning", unowned.display)}`);
	}
	return [...lines, ...below, ...explain];
}

const NO_JOURNAL = "no journal open";

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
					sessionId: telemetry?.live()?.sessionId ?? null,
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
