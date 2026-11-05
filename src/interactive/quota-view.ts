import type { QuotaStateV1, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factKnownValue } from "../core/telemetry/known.js";
import type { QuotaSeverity } from "../domains/quota/presentation.js";
import { severityForPct } from "../domains/quota/presentation.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import type { EnqueuedRun } from "../domains/telemetry/index.js";
import { visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import {
	type DispatchBoardRow,
	type DispatchBoardStatus,
	type DispatchStatusPresentation,
	dispatchBoardItems,
	dispatchStatusPresentation,
	dispatchUsageText,
	runTableRows,
	USAGE_NO_CALLS,
	USAGE_NOT_MEASURED,
} from "./dispatch-board.js";
import type { ClioToken, TableCell, Tone } from "./theme/index.js";
import {
	chipRows,
	clioTheme,
	emptyState,
	GLYPH,
	meter,
	NARROW_WIDTH,
	padAnsi,
	sectionRule,
	statusChip,
	tableRows,
} from "./theme/index.js";

export type QuotaProviders = Readonly<QuotaStateV1["providers"]>;
const clean = (text: string) => sanitizeCallTargetText(redactSecretString(text));
const tone = (severity: QuotaSeverity): ClioToken =>
	severity === "critical" ? "error" : severity === "normal" ? "counter" : "warning";

/** Filled cells mean consumed account usage; text is always the read model's display (#434). */
export function quotaMeter(usedPct: number, cells: number, severity: QuotaSeverity = severityForPct(usedPct)): string {
	const count = Math.max(1, Math.floor(cells));
	const used = Math.max(0, Math.min(100, Number.isFinite(usedPct) ? usedPct : 0));
	const filled = Math.round((used / 100) * count);
	const theme = clioTheme();
	return (
		theme.fg(severity === "normal" ? "meterFill" : tone(severity), GLYPH.meterFull.repeat(filled)) +
		theme.fg("meterFree", GLYPH.meterEmpty.repeat(count - filled))
	);
}
/** `2d 0h`, `2h 0m` or `7m` until `reset`; null when the time is unknown or has passed. */
function quotaResetDuration(reset: string | null, now = Date.now()): string | null {
	const timestamp = reset === null ? NaN : Date.parse(reset);
	if (!Number.isFinite(timestamp)) return null;
	const minutes = Math.max(0, Math.ceil((timestamp - now) / 60_000));
	if (minutes === 0) return null;
	return minutes >= 1440
		? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
		: minutes >= 60
			? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
			: `${minutes}m`;
}

export function quotaResetLabel(
	reset: string | null,
	now = Date.now(),
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
	const timestamp = reset === null ? NaN : Date.parse(reset);
	if (!Number.isFinite(timestamp)) return "Reset time not reported";
	const absolute = new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	}).format(timestamp);
	const duration = quotaResetDuration(reset, now);
	return duration === null
		? `Reset time passed · awaiting provider update (${absolute} · ${timeZone})`
		: `Resets in ${duration} · ${absolute} (${timeZone})`;
}

/** The meter tone for an account window: the shared fill until the limit is near, then the warning tones. */
function quotaTone(severity: QuotaSeverity): Tone | "meter" {
	return severity === "critical" ? "error" : severity === "normal" ? "meter" : "warning";
}

export interface QuotaAccountRowsOptions {
	/** One row per window with the account in its label, for a page that lists every account at once. */
	compact?: boolean;
	now?: number;
	timeZone?: string;
}

/** The widest a meter row's label may grow, as a share of the row. */
const QUOTA_LABEL_SHARE = 0.38;
/** The longest bar an account meter draws. */
const QUOTA_METER_CELLS = 48;

/**
 * Every account's windows as meter rows, `label ━━━━━━──── 91%`, with the
 * labels in one column so the meters start together and the percentages end
 * together. The full form heads each account with its name and plan and puts
 * the reset time under each meter; the compact form folds the account name
 * into the label and the countdown into the amount. A stale reading, a failed
 * credential and a credit balance are rows too, so no account is silent (#434).
 */
export function quotaAccountRows(
	providers: QuotaProviders,
	width: number,
	options: QuotaAccountRowsOptions = {},
): string[] {
	const theme = clioTheme();
	const safe = Math.max(1, Math.floor(width));
	if (!providers.length) return [theme.fg("annotation", "Subscriptions · no journaled quota readings")];
	const compact = options.compact === true;
	const now = options.now ?? Date.now();
	type Entry =
		| { kind: "head"; text: string; meta: string }
		| { kind: "meter"; label: string; pct: number; display: string; severity: QuotaSeverity; reset: string | null }
		| { kind: "note"; text: string; tone: Tone };
	const entries: Entry[] = [];
	for (const account of providers) {
		const name = clean(account.displayName);
		const title = compact ? name : clean(`${name}${account.plan ? ` · ${account.plan}` : ""}`);
		const stale = account.stale ? `${theme.fg("warning", "STALE")} ${theme.fg("divider", "·")} ` : "";
		if (!compact) {
			const seen = account.observedAt ? `observed ${account.observedAt.slice(11, 16)}` : "";
			entries.push({
				kind: "head",
				text: `${stale}${theme.style("sectionHeading", title, { bold: true })}`,
				meta: [account.source.replaceAll("-", " "), seen].filter((part) => part.length > 0).join(" · "),
			});
		}
		if (account.status !== "ok" || account.message) {
			const status = {
				expired: "Credentials expired · refresh credentials",
				no_credentials: "Credentials unavailable",
				error: "Quota read failed",
				loading: "Loading quota",
				ok: "Provider notice",
			}[account.status];
			entries.push({
				kind: "note",
				text: `${compact ? `${title} · ` : ""}${status}${account.message ? ` · ${account.message}` : ""}${account.retryAfter ? ` · retry after ${account.retryAfter.display}` : ""}`,
				tone: "warning",
			});
		}
		if (account.credits) {
			const pct = account.credits.usedPct;
			entries.push({
				kind: "note",
				text: `${compact ? `${title} · ` : ""}Credits ${account.credits.display}${pct.fact.kind === "measured" || pct.fact.kind === "estimated" ? ` · ${pct.display} used` : ""}`,
				tone: "neutral",
			});
		}
		const windows = [...account.windows].sort((a, b) => factKnownValue(b.usedPct.fact) - factKnownValue(a.usedPct.fact));
		for (const window of windows) {
			const pct = factKnownValue(window.usedPct.fact);
			const label = clean(window.label ?? window.key);
			entries.push({
				kind: "meter",
				label: compact ? `${account.stale ? "STALE · " : ""}${title} · ${label}` : label,
				pct,
				display: window.usedPct.display,
				severity: severityForPct(pct),
				reset: window.resetsAt,
			});
		}
		if (!windows.length && !account.credits && account.status === "ok")
			entries.push({ kind: "note", text: `${title} · no windows reported`, tone: "muted" });
	}
	const indent = compact ? 0 : 2;
	const room = Math.max(8, safe - indent);
	// Below the narrow width the full form stacks a window's label above its
	// meter, so a long scope name keeps every word; the compact form clips.
	const stacked = !compact && room < NARROW_WIDTH;
	const widest = Math.max(0, ...entries.map((entry) => (entry.kind === "meter" ? visibleWidth(entry.label) : 0)));
	const labelWidth = Math.min(
		widest,
		compact ? Math.max(6, Math.floor(room * QUOTA_LABEL_SHARE)) : Math.max(6, room - 14),
	);
	const pad = " ".repeat(indent);
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "head") {
			const meta = theme.fg("annotation", entry.meta);
			const gap = safe - visibleWidth(entry.text) - visibleWidth(meta);
			out.push(gap >= 2 ? `${entry.text}${" ".repeat(gap)}${meta}` : padAnsi(entry.text, safe));
			continue;
		}
		if (entry.kind === "note") {
			const chip =
				entry.tone === "warning"
					? statusChip(theme, "warning", clean(entry.text))
					: theme.fg(entry.tone === "muted" ? "annotation" : "body", clean(entry.text));
			out.push(...wrapTextWithAnsi(`${pad}${chip}`, safe));
			continue;
		}
		const countdown = quotaResetDuration(entry.reset, now);
		const amount = compact
			? countdown !== null && room >= 48
				? `${entry.display} · ${countdown}`
				: entry.display
			: `${entry.display} used`;
		// The bar stops at 48 cells however wide the row: past that a meter gains
		// room, not resolution, and the percentages drift away from their labels.
		const cap = QUOTA_METER_CELLS + 1 + visibleWidth(amount);
		const tone = quotaTone(entry.severity);
		if (stacked) {
			out.push(
				`${pad}${theme.fg("fieldName", entry.label)}`,
				`${pad}  ${meter(theme, { value: entry.pct, max: 100, width: Math.min(Math.max(4, room - 2), cap), tone, amount })}`,
			);
		} else {
			const label = padAnsi(theme.fg("fieldName", entry.label), labelWidth, GLYPH.ellipsis);
			const barWidth = Math.min(Math.max(4, room - labelWidth - 1), cap);
			out.push(`${pad}${label} ${meter(theme, { value: entry.pct, max: 100, width: barWidth, tone, amount })}`);
		}
		if (!compact) out.push(`${pad}  ${theme.fg("annotation", quotaResetLabel(entry.reset, now, options.timeZone))}`);
	}
	return out.flatMap((line) => wrapTextWithAnsi(line, safe));
}

/** The latest journaled account readings; missing readings remain unavailable (#434). */
export function renderQuotaAccounts(
	providers: QuotaProviders,
	width: number,
	options: { compact?: boolean; now?: number; timeZone?: string } = {},
): string[] {
	return quotaAccountRows(providers, width, {
		...(options.compact === undefined ? {} : { compact: options.compact }),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
	});
}

/** Only a known local credential owner can be associated with a reading (#434). */
function routeAccount(route: Pick<DispatchBoardRow, "runtimeId" | "node">, providers: QuotaProviders) {
	if (route.node && route.node !== "local") return undefined;
	const provider = (
		{
			"claude-code": "claude-code",
			"claude-sdk": "claude-code",
			"anthropic-max": "anthropic-max",
			"antigravity-code": "antigravity",
		} as Record<string, string>
	)[route.runtimeId];
	return providers.find((item) => provider !== undefined && item.credentials.includes(provider));
}

export function routeWeeklyQuota(
	route: Pick<DispatchBoardRow, "runtimeId" | "wireModelId" | "node">,
	providers: QuotaProviders,
): { label: string; account: string; severity: QuotaSeverity } | null {
	const account = routeAccount(route, providers);
	const weekly = account?.windows.filter((window) => {
		if (window.key !== "weekly" && !window.key.endsWith(".weekly")) return false;
		if (account.provider !== "antigravity") return true;
		const label = (window.label ?? "").toLowerCase();
		const model = route.wireModelId.toLowerCase();
		return model.includes("gemini")
			? label.includes("gemini")
			: /claude|opus|sonnet|haiku/.test(model)
				? label.includes("claude")
				: model.includes("gpt")
					? label.includes("gpt")
					: false;
	});
	if (account?.status !== "ok" || weekly?.length !== 1) return null;
	const window = weekly[0];
	if (!window) return null;
	return {
		label: `${account.stale ? "STALE · " : ""}weekly ${window.usedPct.display} used`,
		account: account.provider,
		severity: severityForPct(factKnownValue(window.usedPct.fact)),
	};
}

export function workerQuotaLabel(row: Pick<DispatchBoardRow, "runtimeId" | "node">, providers: QuotaProviders): string {
	if (row.node && row.node !== "local") return "Account quota unavailable for remote credentials";
	const account = routeAccount(row, providers);
	if (!account) return "Account quota not linked to this runtime";
	return `Shared ${account.provider}${account.stale ? " · STALE" : ""} · ${account.windows.map((window) => `${window.label ?? window.key} ${window.usedPct.display} used`).join(" · ") || "no windows reported"}`;
}

/** A run the session's telemetry references, as the read model holds it; `enqueued` names an unsettled run's route. */
export interface RecordedWorkerRun {
	run: RunTelemetryV1;
	enqueued: EnqueuedRun | null;
}

type RunOutcome = NonNullable<RunTelemetryV1["settled"]>["outcome"];

/** A recorded outcome wears the board's matching glyph; a board status has no word for the rarer outcomes. */
const RECORDED_OUTCOME: Record<RunOutcome, { status: DispatchBoardStatus; label?: string }> = {
	succeeded: { status: "completed" },
	failed: { status: "failed" },
	timed_out: { status: "failed", label: "timed out" },
	stalled: { status: "stale", label: "stalled" },
	canceled: { status: "aborted", label: "cancelled" },
	denied_by_policy: { status: "failed", label: "denied by policy" },
	spawn_failed: { status: "failed", label: "spawn failed" },
};

function recordedStatus(run: RunTelemetryV1): DispatchStatusPresentation {
	// No settlement means the host never saw the run end; its elapsed clock would still be counting, so none is shown.
	if (!run.settled) return { ...dispatchStatusPresentation("stale"), label: "not settled" };
	const { status, label } = RECORDED_OUTCOME[run.settled.outcome];
	const presentation = dispatchStatusPresentation(status);
	return label ? { ...presentation, label } : presentation;
}

function recordedRoute({ run, enqueued }: RecordedWorkerRun): string {
	const route = run.settled?.route ?? enqueued;
	if (!route) return "Route not recorded";
	const node = run.settled ? run.settled.node?.id : enqueued?.node;
	return `${route.targetId} / ${route.wireModelId}${node && node !== "local" ? ` · ${node}` : ""}`;
}

/** Board rows first, in the board's order; recorded runs the board does not hold follow in the order given. */
export function renderWorkerUsage(
	rows: ReadonlyArray<DispatchBoardRow>,
	recorded: ReadonlyArray<RecordedWorkerRun>,
	snapshots: QuotaProviders,
	width: number,
): string[] {
	const theme = clioTheme();
	const safe = Math.max(1, Math.floor(width));
	const onBoard = new Set(rows.map((row) => row.runId));
	const history = recorded.filter(({ run }) => !onBoard.has(run.row.runId));
	const out = [
		theme.fg("annotation", "Active and recent workers · recorded tokens and cost · account limits are shared."),
	];
	if (!rows.length && !history.length) {
		out.push("", ...emptyState(theme, "No worker invocations recorded.", safe));
		return out;
	}
	if (rows.length) {
		const table = runTableRows(dispatchBoardItems(rows), safe, { quota: snapshots });
		out.push(
			sectionRule(theme, safe, "On the board", { meta: `${rows.length} run${rows.length === 1 ? "" : "s"}` }),
			...table,
		);
		// A narrow table drops its cost column first, and that column is what tells these two apart.
		const said = table.join("\n");
		const legend = [
			rows.some((row) => row.usage.kind === "unavailable") && !said.includes(USAGE_NOT_MEASURED)
				? `n/a ${USAGE_NOT_MEASURED}`
				: null,
			rows.some((row) => row.usage.kind === "pending") && !said.includes(USAGE_NO_CALLS) ? `— ${USAGE_NO_CALLS}` : null,
		].filter((part): part is string => part !== null);
		if (legend.length > 0) out.push(theme.fg("annotation", legend.join(" · ")));
		const accounts = new Map<string, string>();
		for (const row of rows) accounts.set(row.runtimeId, clean(workerQuotaLabel(row, snapshots)));
		out.push(
			...[...accounts].flatMap(([runtime, label]) =>
				chipRows(theme, [theme.fg("annotation", runtime), theme.fg("body", label)], safe),
			),
		);
	}
	if (history.length) {
		out.push(
			sectionRule(theme, safe, "Recorded", { meta: `${history.length} run${history.length === 1 ? "" : "s"}` }),
			...tableRows(
				theme,
				{
					columns: [
						{ label: "status", priority: 10 },
						{ label: "agent", priority: 9, max: 22 },
						{ label: "elapsed", align: "right", priority: 6, tone: "muted" },
						{ label: "route", priority: 7, max: Math.max(16, Math.floor(safe * 0.35)) },
						{ label: "total", align: "right", priority: 5 },
						{ label: "cost", align: "right", priority: 4 },
						{ label: "run", priority: 1, tone: "muted" },
					],
					rows: history.map((entry): Array<string | TableCell> => {
						const { run, enqueued } = entry;
						const status = recordedStatus(run);
						const agent = run.settled?.agentId ?? enqueued?.agentId ?? "agent not recorded";
						const usage = dispatchUsageText(
							run.row.source === "unavailable"
								? { kind: "unavailable" }
								: {
										kind: "ready",
										prompt: run.tokens.prompt,
										output: run.tokens.output,
										total: run.row.tokens,
										usd: run.row.usd,
									},
						);
						return [
							`${theme.fg(status.glyphToken ?? status.token, status.glyph)} ${theme.fg(status.token, status.label)}`,
							theme.fg("workerIdentity", clean(agent)),
							run.settled ? run.activity.elapsed.display : "",
							clean(recordedRoute(entry)),
							usage.total,
							usage.cost,
							run.row.runId,
						];
					}),
				},
				safe,
			),
		);
	}
	out.push(theme.fg("annotation", "/view dispatch:<run> opens a run's record"));
	return out.flatMap((line) => wrapTextWithAnsi(theme.base("fieldValue", line), safe));
}
