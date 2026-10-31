import type { QuotaStateV1 } from "../core/telemetry/dto.js";
import { factKnownValue } from "../core/telemetry/known.js";
import type { QuotaSeverity } from "../domains/quota/presentation.js";
import { severityForPct } from "../domains/quota/presentation.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import { type DispatchBoardRow, dispatchStatusPresentation, dispatchUsageText } from "./dispatch-board.js";
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
		const title = clean(`${account.stale ? "STALE · " : ""}${account.provider}`);
		if (!options.compact) out.push(theme.style("sectionHeading", title, { bold: true }));
		for (const window of [...account.windows].sort(
			(a, b) => factKnownValue(b.usedPct.fact) - factKnownValue(a.usedPct.fact),
		)) {
			const label = clean(`${window.label ?? window.key} ${window.usedPct.display} used`);
			const meter = quotaMeter(factKnownValue(window.usedPct.fact), options.compact ? 8 : Math.min(48, width));
			out.push(...wrapTextWithAnsi(`${meter} ${options.compact ? `${title} · ` : ""}${label}`, Math.max(1, width)));
			if (!options.compact)
				out.push(theme.fg("annotation", quotaResetLabel(window.resetsAt, options.now, options.timeZone)));
		}
		if (!account.windows.length) out.push(theme.fg("annotation", `${title} · no windows reported`));
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
	return providers.find((item) => item.provider === provider);
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
	if (!account || weekly?.length !== 1) return null;
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

export function renderWorkerUsage(
	rows: ReadonlyArray<DispatchBoardRow>,
	snapshots: QuotaProviders,
	width: number,
): string[] {
	const theme = clioTheme();
	const out = [
		theme.fg("annotation", "Active and recent workers · recorded tokens and cost · account limits are shared."),
	];
	if (!rows.length) out.push("", "No worker invocations recorded.");
	for (const row of rows) {
		const usage = dispatchUsageText(row.usage);
		const status = dispatchStatusPresentation(row.status);
		out.push(
			"",
			`${theme.fg("footerIdentity", clean(row.agentId))} ${theme.fg("divider", "·")} ${theme.fg(status.glyphToken ?? status.token, status.glyph)} ${theme.fg(status.token, status.label)} ${theme.fg("divider", "·")} ${theme.fg("toolMetadata", row.telemetry?.activity.elapsed.display ?? "not available")}`,
		);
		out.push(clean(`${row.targetId} / ${row.wireModelId}${row.node ? ` · ${row.node}` : ""}`));
		out.push(
			row.usage.kind === "ready"
				? `${usage.total} recorded tokens · input ${usage.prompt} · output ${usage.output} · ${usage.cost}`
				: row.usage.kind === "pending"
					? "Token usage awaiting the run's first journaled call"
					: "Token usage not available",
		);
		const context = row.telemetry?.activity.contextTokens;
		if (context) out.push(`Context ${context.display}`);
		out.push(theme.fg("body", clean(workerQuotaLabel(row, snapshots))));
		out.push(theme.fg("annotation", clean(`/view dispatch:${row.runId}`)));
	}
	return out.flatMap((line) => wrapTextWithAnsi(theme.base("fieldValue", line), Math.max(1, width)));
}
