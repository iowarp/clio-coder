import { formatFooterTokens } from "../core/display-units.js";
import type { JobRecord } from "../core/job-types.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { Text } from "../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import type { DispatchBoardRow, DispatchBoardStatus } from "./dispatch-board.js";
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

/** Run counts only: tokens are the read model's to total, and the footer already shows the session's (#434 §11.3). */
function dispatchStatusCounts(rows: ReadonlyArray<DispatchBoardRow>): {
	active: number;
	completed: number;
	failed: number;
} {
	let active = 0;
	let completed = 0;
	let failed = 0;
	for (const row of rows) {
		if (ACTIVE_DISPATCH_STATUSES.has(row.status)) active += 1;
		else if (row.status === "completed") completed += 1;
		else if (FAILED_DISPATCH_STATUSES.has(row.status)) failed += 1;
	}
	return { active, completed, failed };
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
	const theme = clioTheme();
	const tone = job.cancelRequested || job.state === "paused" || job.persistenceError !== null ? "warning" : "annotation";
	// State leads so a narrow rail keeps "paused" or "not saved". Ids and
	// pending reasons stay with `/loop status`; navigation stores its raw park
	// code as the reason.
	let text = `Loop ${state}`;
	const append = (detail: string): boolean => {
		if (visibleWidth(text) + 3 + visibleWidth(detail) > width) return false;
		text += ` · ${detail}`;
		return true;
	};
	const counter = job.spec.count === null ? `${job.settled} settled` : `${job.settled}/${job.spec.count}`;
	const dueAt = state === "waiting" ? job.nextDueAt : null;
	if (dueAt !== null) {
		const filled = Math.min(6, Math.max(0, Math.floor((1 - (dueAt - now) / job.spec.intervalMs) * 6)));
		const meter =
			theme.fg("composerRail", GLYPH.meterFull.repeat(filled)) + theme.fg("border", GLYPH.meterEmpty.repeat(6 - filled));
		if (!append(`${meter} · ${counter}`)) append(counter);
	} else append(counter);
	if (jobs.length > 1) append(`+${jobs.length - 1} loops`);
	if (dueAt !== null) append(dueAt <= now ? "due now" : `in ${formatCompactMs(dueAt - now)}`);
	return theme.base(tone, fitFooterText(text, width, "…"));
}
