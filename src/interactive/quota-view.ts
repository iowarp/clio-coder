import type { QuotaStateV1, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factKnownValue } from "../core/telemetry/known.js";
import type { QuotaSeverity } from "../domains/quota/presentation.js";
import { severityForPct } from "../domains/quota/presentation.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import type { EnqueuedRun } from "../domains/telemetry/index.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import {
	type DispatchBoardRow,
	type DispatchBoardStatus,
	type DispatchRunUsage,
	type DispatchStatusPresentation,
	dispatchStatusPresentation,
	dispatchUsageText,
} from "./dispatch-board.js";
import type { ClioToken } from "./theme/index.js";
import { clioTheme, GLYPH } from "./theme/index.js";

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
	const minutes = Math.max(0, Math.ceil((timestamp - now) / 60_000));
	const duration =
		minutes >= 1440
			? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
			: minutes >= 60
				? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
				: `${minutes}m`;
	return minutes === 0
		? `Reset time passed · awaiting provider update (${absolute} · ${timeZone})`
		: `Resets in ${duration} · ${absolute} (${timeZone})`;
}

/** The latest journaled account readings; missing readings remain unavailable (#434). */
export function renderQuotaAccounts(
	providers: QuotaProviders,
	width: number,
	options: { compact?: boolean; now?: number; timeZone?: string } = {},
): string[] {
	const theme = clioTheme();
	if (!providers.length) return [theme.fg("annotation", "Subscriptions · no journaled quota readings")];
	const out: string[] = [];
	for (const account of providers) {
		const title = clean(
			`${account.stale ? "STALE · " : ""}${account.displayName}${account.plan ? ` · ${account.plan}` : ""}`,
		);
		if (!options.compact) out.push(theme.style("sectionHeading", title, { bold: true }));
		if (account.status !== "ok" || account.message) {
			const status = {
				expired: "Credentials expired · refresh credentials",
				no_credentials: "Credentials unavailable",
				error: "Quota read failed",
				loading: "Loading quota",
				ok: "Provider notice",
			}[account.status];
			out.push(
				theme.fg(
					"warning",
					clean(
						`${options.compact ? `${title} · ` : ""}${status}${account.message ? ` · ${account.message}` : ""}${account.retryAfter ? ` · retry after ${account.retryAfter.display}` : ""}`,
					),
				),
			);
		}
		if (account.credits) {
			const pct = account.credits.usedPct;
			out.push(
				clean(
					`${options.compact ? `${title} · ` : ""}Credits ${account.credits.display}${pct.fact.kind === "measured" || pct.fact.kind === "estimated" ? ` · ${pct.display} used` : ""}`,
				),
			);
		}
		for (const window of [...account.windows].sort(
			(a, b) => factKnownValue(b.usedPct.fact) - factKnownValue(a.usedPct.fact),
		)) {
			const label = clean(`${window.label ?? window.key} ${window.usedPct.display} used`);
			const meter = quotaMeter(factKnownValue(window.usedPct.fact), options.compact ? 8 : Math.min(48, width));
			out.push(...wrapTextWithAnsi(`${meter} ${options.compact ? `${title} · ` : ""}${label}`, Math.max(1, width)));
			if (!options.compact)
				out.push(theme.fg("annotation", quotaResetLabel(window.resetsAt, options.now, options.timeZone)));
		}
		if (!account.windows.length && !account.credits && account.status === "ok")
			out.push(theme.fg("annotation", `${title} · no windows reported`));
	}
	return out.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
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
	canceled: { status: "aborted", label: "canceled" },
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

function workerUsageLine(usage: DispatchRunUsage): string {
	const text = dispatchUsageText(usage);
	return usage.kind === "ready"
		? `${text.total} recorded tokens · input ${text.prompt} · output ${text.output} · ${text.cost}`
		: usage.kind === "pending"
			? "Token usage awaiting the run's first journaled call"
			: "Token usage not available";
}

/** Board rows first, in the board's order; recorded runs the board does not hold follow in the order given. */
export function renderWorkerUsage(
	rows: ReadonlyArray<DispatchBoardRow>,
	recorded: ReadonlyArray<RecordedWorkerRun>,
	snapshots: QuotaProviders,
	width: number,
): string[] {
	const theme = clioTheme();
	const onBoard = new Set(rows.map((row) => row.runId));
	const history = recorded.filter(({ run }) => !onBoard.has(run.row.runId));
	const out = [
		theme.fg("annotation", "Active and recent workers · recorded tokens and cost · account limits are shared."),
	];
	const divider = theme.fg("divider", "·");
	if (!rows.length && !history.length) out.push("", "No worker invocations recorded.");
	for (const row of rows) {
		const status = dispatchStatusPresentation(row.status);
		out.push(
			"",
			`${theme.fg("footerIdentity", clean(row.agentId))} ${divider} ${theme.fg(status.glyphToken ?? status.token, status.glyph)} ${theme.fg(status.token, status.label)} ${divider} ${theme.fg("toolMetadata", row.telemetry?.activity.elapsed.display ?? "not available")}`,
		);
		out.push(clean(`${row.targetId} / ${row.wireModelId}${row.node ? ` · ${row.node}` : ""}`));
		out.push(workerUsageLine(row.usage));
		const context = row.telemetry?.activity.contextTokens;
		if (context) out.push(`Context ${context.display}`);
		out.push(theme.fg("body", clean(workerQuotaLabel(row, snapshots))));
		out.push(theme.fg("annotation", clean(`/view dispatch:${row.runId}`)));
	}
	for (const entry of history) {
		const { run, enqueued } = entry;
		const status = recordedStatus(run);
		const agent = run.settled?.agentId ?? enqueued?.agentId ?? "agent not recorded";
		const elapsed = run.settled ? ` ${divider} ${theme.fg("toolMetadata", run.activity.elapsed.display)}` : "";
		out.push(
			"",
			`${theme.fg("footerIdentity", clean(agent))} ${divider} ${theme.fg(status.glyphToken ?? status.token, status.glyph)} ${theme.fg(status.token, status.label)}${elapsed}`,
		);
		out.push(clean(recordedRoute(entry)));
		out.push(
			workerUsageLine(
				run.row.source === "unavailable"
					? { kind: "unavailable" }
					: {
							kind: "ready",
							prompt: run.tokens.prompt,
							output: run.tokens.output,
							total: run.row.tokens,
							usd: run.row.usd,
						},
			),
		);
		out.push(theme.fg("annotation", clean(`/view dispatch:${run.row.runId}`)));
	}
	return out.flatMap((line) => wrapTextWithAnsi(theme.base("fieldValue", line), Math.max(1, width)));
}
