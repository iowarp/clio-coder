import { costAggregateForAmount, formatCostAggregate } from "../domains/observability/index.js";
import {
	foldDuplicateAccounts,
	formatPct,
	primaryWindow,
	type QuotaSeverity,
	severityForPct,
	windowSeverity,
} from "../domains/quota/presentation.js";
import type { UsageSnapshot } from "../domains/quota/types.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { formatFooterTokens } from "./footer-panel.js";
import { type ClioToken, clioTheme, formatCompactMs } from "./theme/index.js";

const clean = (text: string) => sanitizeCallTargetText(redactSecretString(text));
const tone = (severity: QuotaSeverity): ClioToken =>
	severity === "critical" ? "error" : severity === "normal" ? "accent" : "warning";

/** Filled cells always mean consumed usage, on every surface. */
export function quotaMeter(usedPct: number, cells: number, severity: QuotaSeverity = severityForPct(usedPct)): string {
	const count = Math.max(1, Math.floor(cells));
	const used = Math.max(0, Math.min(100, Number.isFinite(usedPct) ? usedPct : 0));
	const filled = Math.round((used / 100) * count);
	const theme = clioTheme();
	return theme.fg(tone(severity), "━".repeat(filled)) + theme.fg("frame", "─".repeat(count - filled));
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

/** Account-wide facts only: never infer a worker's share from changing percentages. */
export function renderQuotaAccounts(
	snapshots: ReadonlyArray<UsageSnapshot>,
	width: number,
	options: { compact?: boolean; now?: number; timeZone?: string } = {},
): string[] {
	const theme = clioTheme();
	const now = options.now ?? Date.now();
	const accounts = foldDuplicateAccounts(snapshots).filter((account) => account.status !== "no_credentials");
	if (!accounts.length) return [theme.fg("dim", "Subscriptions · loading")];
	const out: string[] = [];
	for (const account of accounts) {
		const title = clean(`${account.displayName}${account.plan ? ` (${account.plan})` : ""}`);
		const age =
			account.fetchedAt === null ? null : Math.max(0, Math.floor((now - Date.parse(account.fetchedAt)) / 60_000));
		const freshness = account.stale
			? "STALE · last good reading"
			: age === null || !Number.isFinite(age)
				? ""
				: age === 0
					? "updated just now"
					: `updated ${age}m ago`;
		if (options.compact) {
			const window = primaryWindow(account);
			const ordered =
				window && ["warning", "critical"].includes(windowSeverity(window))
					? [window, ...account.windows.filter((item) => item !== window)]
					: account.windows;
			const windows = ordered
				.map(
					(item) =>
						`${item.scope && item.scope !== item.label ? `${item.scope} ` : ""}${item.label} ${formatPct(item.usedPct)} used`,
				)
				.join(" · ");
			const detail =
				account.status !== "ok"
					? (account.message ?? account.status)
					: account.providerId === "local"
						? "$0.00 · no subscription window consumed"
						: windows || account.credits?.display || "no windows reported";
			const meter = window && width >= 65 ? `${quotaMeter(window.usedPct, 8, windowSeverity(window))} ` : "";
			out.push(
				truncateToWidth(
					`${meter}${theme.fg(account.status !== "ok" || account.stale ? "warning" : "muted", `${account.stale ? "STALE · " : ""}${title}`)}  ${clean(detail)}`,
					width,
					"…",
					true,
				),
			);
			continue;
		}
		if (out.length) out.push("");
		out.push(theme.style("accent", title, { bold: true }));
		if (freshness) out.push(theme.fg(account.stale ? "warning" : "dim", freshness));
		if (account.status !== "ok")
			out.push(theme.fg("warning", clean(`${account.status} · ${account.message ?? "usage unavailable"}`)));
		let scope: string | undefined;
		for (const window of account.windows) {
			if (window.scope && scope !== window.scope) {
				scope = window.scope;
				out.push(theme.style("muted", clean(scope), { bold: true }));
			}
			const label = `${window.key.startsWith("weekly_scoped.") ? "Weekly" : window.label} · ${formatPct(window.usedPct)} used · ${formatPct(Math.max(0, 100 - window.usedPct))} remaining${window.active ? " · active limit" : ""}`;
			out.push(clean(label));
			out.push(quotaMeter(window.usedPct, Math.max(1, Math.min(48, width)), windowSeverity(window)));
			out.push(theme.fg("dim", quotaResetLabel(window.resetsAt, now, options.timeZone)));
		}
		if (account.credits) {
			out.push(
				clean(
					`${account.providerId === "local" ? "Local inference" : "Usage credits"} · ${account.credits.display}${account.credits.usedPct === null ? "" : ` · ${formatPct(account.credits.usedPct)} used`}`,
				),
			);
			if (account.credits.usedPct !== null) out.push(quotaMeter(account.credits.usedPct, Math.min(48, width)));
		}
		if (account.status === "ok" && account.message)
			out.push(theme.fg(account.stale ? "warning" : "dim", clean(account.message)));
		if (account.status === "ok" && !account.windows.length && !account.credits && !account.message)
			out.push(theme.fg("dim", "Connected · no usage windows reported"));
		if (account.retryAfterSeconds != null) out.push(theme.fg("warning", `Retry after ${account.retryAfterSeconds}s`));
	}
	return out.flatMap((line) => (visibleWidth(line) > width ? wrapTextWithAnsi(line, Math.max(1, width)) : [line]));
}

/** The route must share the credential owner read by the quota adapter. */
function routeAccount(
	route: Pick<DispatchBoardRow, "runtimeId" | "node">,
	snapshots: ReadonlyArray<UsageSnapshot>,
): UsageSnapshot | undefined {
	if (route.node && route.node !== "local") return undefined;
	const provider = (
		{
			"claude-code": "claude-code",
			"claude-sdk": "claude-code",
			"anthropic-max": "anthropic-max",
			"antigravity-code": "antigravity",
		} as Record<string, string>
	)[route.runtimeId];
	// Clio's openai-codex OAuth storage is independent of Codex CLI auth.json.
	return snapshots.find((item) => item.providerId === provider);
}

/** A weekly badge only when both the account and model group are known. */
export function routeWeeklyQuota(
	route: Pick<DispatchBoardRow, "runtimeId" | "wireModelId" | "node">,
	snapshots: ReadonlyArray<UsageSnapshot>,
): { label: string; account: string; severity: QuotaSeverity } | null {
	const account = routeAccount(route, snapshots);
	if (account?.status !== "ok") return null;
	const weekly = account.windows.filter((window) => window.key === "weekly" || window.key.endsWith(".weekly"));
	const model = route.wireModelId.toLowerCase();
	const matches =
		account.providerId === "antigravity"
			? weekly.filter((window) => {
					const scope = window.scope?.toLowerCase() ?? "";
					if (model.includes("gemini")) return scope.includes("gemini");
					if (/claude|opus|sonnet|haiku/.test(model)) return scope.includes("claude");
					if (model.includes("gpt")) return scope.includes("gpt");
					return false;
				})
			: weekly.filter((window) => !window.scope);
	if (matches.length !== 1) return null;
	const window = matches[0];
	if (!window) return null;
	return {
		label: `${account.stale ? "STALE · " : ""}weekly ${formatPct(Math.max(0, Math.min(100, 100 - window.usedPct)))} left`,
		account: account.displayName,
		severity: windowSeverity(window),
	};
}

export function workerQuotaLabel(
	row: Pick<DispatchBoardRow, "runtimeId" | "node">,
	snapshots: ReadonlyArray<UsageSnapshot>,
): string {
	// Remote workers and generic transports may use different credentials. Only
	// known local credential owners can be associated with this process's reads.
	if (row.node && row.node !== "local") return "Account quota unavailable for remote credentials";
	const account = routeAccount(row, snapshots);
	if (!account) return "Account quota not linked to this runtime";
	if (account.status !== "ok") return `${account.displayName} · ${account.message ?? account.status}`;
	return `Shared ${account.displayName}${account.stale ? " · STALE" : ""} · ${account.windows.map((window) => `${window.scope && window.scope !== window.label ? `${window.scope} ` : ""}${window.label} ${formatPct(Math.max(0, 100 - window.usedPct))} left`).join(" · ") || "no windows reported"}`;
}

export function renderWorkerUsage(
	rows: ReadonlyArray<DispatchBoardRow>,
	snapshots: ReadonlyArray<UsageSnapshot>,
	width: number,
): string[] {
	const theme = clioTheme();
	const out = [theme.fg("dim", "Active and recent workers · recorded tokens and cost · account limits are shared.")];
	if (!rows.length) out.push("", "No worker invocations recorded.");
	for (const row of rows) {
		const cost = formatCostAggregate(costAggregateForAmount(row.costUsd, row.costProvenance)) ?? "cost not reported";
		out.push(
			"",
			theme.style("agent", clean(`${row.agentId} · ${row.status} · ${formatCompactMs(row.elapsedMs)}`), { bold: true }),
		);
		out.push(clean(`${row.targetId} / ${row.wireModelId}${row.node ? ` · ${row.node}` : ""}`));
		out.push(
			row.tokenCount > 0 || row.inputTokens > 0 || row.outputTokens > 0 || row.progress?.inputTokens !== undefined
				? `${formatFooterTokens(row.tokenCount)} recorded tokens · input ${formatFooterTokens(row.inputTokens)} · output ${formatFooterTokens(row.outputTokens)} · ${cost}`
				: `Token usage not reported · ${cost}`,
		);
		if (row.lastContextTokens !== undefined)
			out.push(
				`Context ${formatFooterTokens(row.lastContextTokens)}${row.contextWindow ? ` / ${formatFooterTokens(row.contextWindow)}` : ""}`,
			);
		out.push(theme.fg("muted", clean(workerQuotaLabel(row, snapshots))));
		out.push(theme.fg("dim", clean(`/view dispatch:${row.runId}`)));
	}
	return out.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}
