import { formatFooterTokens } from "../core/display-units.js";
import type { JobRecord } from "../core/job-types.js";
import type { TokenThroughputSnapshot, UsageBreakdown } from "../domains/observability/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { Text } from "../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import type { DispatchBoardRow, DispatchBoardStatus } from "./dispatch-board.js";
import { formatReasoningChip } from "./status/reasoning.js";
import { clioTheme, formatCompactMs, GLYPH } from "./theme/index.js";

/** Shared footer projection of live and failed worker states. */
export const ACTIVE_DISPATCH_STATUSES: ReadonlySet<DispatchBoardStatus> = new Set([
	"running",
	"enqueued",
	"cancelling",
	"retrying",
	"stale",
]);
export const FAILED_DISPATCH_STATUSES: ReadonlySet<DispatchBoardStatus> = new Set(["failed", "aborted", "dead"]);

export { formatFooterTokens };

/**
 * Build the token-counter footer segment. Returns `null` when no usage has
 * landed yet so the footer stays uncluttered at session start. Cache-read
 * tokens are omitted here to keep the line scannable; reasoning tokens are
 * shown only when the provider exposes them. The `/usage` overlay exposes the
 * full breakdown.
 */
export function tokensSegment(usage: UsageBreakdown | null | undefined): string | null {
	if (!usage) return null;
	const input = Math.max(0, usage.input ?? 0);
	const output = Math.max(0, usage.output ?? 0);
	const reasoning = Math.max(0, usage.reasoningTokens ?? 0);
	const total = Math.max(0, usage.totalTokens ?? input + output);
	if (input + output + reasoning + total === 0 && !usage.missingTokenCalls) return null;
	// Session totals are summed from provider usage payloads, so the chip carries
	// no `≈`. It is built by the same formatter every other reasoning surface
	// uses rather than by a fourth copy of the marker rule.
	const reasoningChip = formatReasoningChip({ tokens: reasoning, provenance: "provider" }, formatFooterTokens);
	const reasoningPart = reasoningChip === null ? "" : ` ${reasoningChip}`;
	const totalPart =
		total > 0 || usage.missingTokenCalls
			? ` Σ${formatFooterTokens(total)}${usage.missingTokenCalls ? ` +? (${usage.missingTokenCalls} call${usage.missingTokenCalls === 1 ? "" : "s"})` : ""}`
			: "";
	return `${GLYPH.up} ${formatFooterTokens(input)} ${GLYPH.down} ${formatFooterTokens(output)}${reasoningPart}${totalPart}`;
}

export function throughputSegment(metric: TokenThroughputSnapshot | null | undefined): string | null {
	const tps = metric?.tokensPerSecond;
	if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0) return null;
	const rounded = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
	return `${GLYPH.speed}${metric?.estimated ? "≈" : ""}${rounded} Tk/s`;
}

function dispatchStatusCounts(rows: ReadonlyArray<DispatchBoardRow>): {
	active: number;
	completed: number;
	failed: number;
	tokens: number;
} {
	let active = 0;
	let completed = 0;
	let failed = 0;
	let tokens = 0;
	for (const row of rows) {
		if (ACTIVE_DISPATCH_STATUSES.has(row.status)) active += 1;
		else if (row.status === "completed") completed += 1;
		else if (FAILED_DISPATCH_STATUSES.has(row.status)) failed += 1;
		tokens += Math.max(0, row.tokenCount);
	}
	return { active, completed, failed, tokens };
}

export function dispatchSegment(rows: ReadonlyArray<DispatchBoardRow> | null | undefined): string | null {
	if (!rows || rows.length === 0) return null;
	const groups = [
		{ label: "helpers", rows: rows.filter(isHelperRun) },
		{ label: "dispatch", rows: rows.filter((row) => !isHelperRun(row)) },
	];
	return groups
		.filter((group) => group.rows.length > 0)
		.map((group) => {
			const counts = dispatchStatusCounts(group.rows);
			const parts: string[] = [];
			if (group.label === "helpers") {
				const names = new Map<string, number>();
				for (const row of group.rows) names.set(row.agentId, (names.get(row.agentId) ?? 0) + 1);
				parts.push(
					[...names]
						.slice(0, 2)
						.map(
							([name, count]) => `${sanitizeCallTargetText(name).slice(0, 24)}${count > 1 ? ` ${GLYPH.times}${count}` : ""}`,
						)
						.join(", "),
				);
				if (names.size > 2) parts.push(`+${names.size - 2} kinds`);
			}
			if (counts.active > 0) parts.push(`${counts.active} active`);
			if (counts.completed > 0) parts.push(`${counts.completed} done`);
			if (counts.failed > 0) parts.push(`${counts.failed} failed`);
			if (counts.tokens > 0) parts.push(`${formatFooterTokens(counts.tokens)}tok`);
			return `${group.label} ${parts.length > 0 ? parts.join(" ") : `${group.rows.length} runs`}`;
		})
		.join(" · ");
}

export interface FooterPanel {
	view: Text;
	refresh(): void;
}

export function fitFooterText(text: string, width: number, ellipsis = ""): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, ellipsis, true) : text;
}

export function loopSegment(jobs: readonly JobRecord[], width: number, now: number): string | null {
	const job = jobs[0];
	if (!job) return null;
	const delivery = job.delivery?.state;
	const running = job.active !== null || delivery === "running";
	const state =
		job.persistenceError !== null
			? "not saved"
			: job.cancelRequested
				? "cancel requested"
				: delivery === "running" || delivery === "pending"
					? `${job.delivery?.kind === "main_turn" ? "analysis" : "notice"} ${delivery === "running" ? "running" : "waiting"}`
					: job.state === "paused"
						? `paused${running ? " · running" : ""}`
						: running
							? "running"
							: job.state === "terminal"
								? "settling"
								: "waiting";
	const id = truncateToWidth(sanitizeCallTargetText(job.id), Math.max(4, Math.min(18, Math.floor(width / 5))), "…");
	const progress = `${job.settled}${job.spec.count === null ? "" : `/${job.spec.count}`} settled`;
	const extra = jobs.length > 1 ? ` · +${jobs.length - 1} jobs` : "";
	let text = `Loop ${id} · ${state} · ${progress}`;
	if (job.state === "active" && job.nextDueAt !== null) {
		text += job.nextDueAt <= now ? " · due now" : ` · next ${formatCompactMs(job.nextDueAt - now)}`;
	}
	if (job.starts !== job.settled && visibleWidth(`${text} · ${job.starts} started${extra}`) <= width)
		text += ` · ${job.starts} started`;
	if (job.pendingReason !== null && visibleWidth(`${text}${extra}`) + 12 < width)
		text += ` · ${truncateToWidth(sanitizeCallTargetText(job.pendingReason), width - visibleWidth(`${text}${extra}`) - 3, "…")}`;
	text = fitFooterText(text, Math.max(1, width - visibleWidth(extra)), "…") + fitFooterText(extra, width);
	if (visibleWidth(`${text} · /loop`) <= width) text += " · /loop";
	return clioTheme().fg(
		job.cancelRequested || job.state === "paused" || job.persistenceError !== null ? "warning" : "annotation",
		fitFooterText(text, width, "…"),
	);
}
