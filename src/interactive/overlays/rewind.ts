/**
 * `/rewind`: the workspace snapshots of this session, newest first, and the
 * confirmation that restores one. `/tree` rewinds the conversation; this
 * rewinds files. The snapshot service lives in `src/domains/workspace-snapshots/`;
 * this module only renders what it reports.
 */

import type {
	RewindOutcome,
	RewindPlan,
	SnapshotDifferences,
	WorkspaceSnapshotRecord,
} from "../../domains/workspace-snapshots/index.js";
import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { isKeyRelease, matchesKey, wrapTextWithAnsi } from "../../engine/tui.js";
import { clockLocal, dateLocal } from "../format-time.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, rule } from "../theme/index.js";
import { type ListOverlayHandle, type ListOverlayItem, openListOverlay } from "./list-overlay.js";

export const REWIND_EMPTY =
	"No workspace snapshots in this session yet. Clio takes one before it first changes files in a turn and before every destructive command, in a Git work tree with safety.snapshots on.";

/** Differences from the work tree: still counting, counted, or not countable. */
export type RewindCounts = "pending" | SnapshotDifferences;

function differenceLabel(n: number, counts: RewindCounts): string {
	if (counts === "pending") return "…";
	if (counts.kind === "unavailable") return "?";
	const count = counts.counts.get(n);
	if (count === undefined) return "?";
	if (count === 0) return "same as now";
	return `${count} file${count === 1 ? "" : "s"} differ${count === 1 ? "s" : ""}`;
}

/** Rows for the snapshot list, one per snapshot, newest first as the service returns them. */
function rewindListItems(records: ReadonlyArray<WorkspaceSnapshotRecord>, counts: RewindCounts): ListOverlayItem[] {
	const theme = clioTheme();
	return records.map((record) => {
		const what = record.tool !== undefined ? `${record.reason} · ${record.tool}` : record.reason;
		return {
			id: String(record.n),
			label: `#${String(record.n).padEnd(4)} ${clockLocal(record.at)}  ${what}`,
			meta: theme.fg("annotation", differenceLabel(record.n, counts)),
			detail: () => {
				const lines = [
					`# Snapshot ${record.n}`,
					`**Taken:** ${dateLocal(record.at)} ${clockLocal(record.at)}`,
					`**Reason:** ${record.reason}`,
				];
				if (record.tool !== undefined)
					lines.push(`**Before:** ${record.tool}${record.toolCallId ? ` (${record.toolCallId})` : ""}`);
				lines.push(`**Differs from now:** ${differenceLabel(record.n, counts)}`);
				if (counts !== "pending" && counts.kind === "unavailable") lines.push(`**Not counted:** ${counts.reason}`);
				lines.push(`**Commit:** ${record.commit.slice(0, 12)} (${record.ref})`);
				if (record.skipped.length > 0) {
					lines.push("**Not in this snapshot:**");
					for (const skip of record.skipped.slice(0, 12))
						lines.push(`- ${skip.path} (${skip.why === "too-large" ? "untracked, over 16 MiB" : "nested repository"})`);
					if (record.skipped.length > 12) lines.push(`- and ${record.skipped.length - 12} more`);
				}
				lines.push("", "Enter shows what a rewind to this snapshot would change before anything is written.");
				return lines;
			},
		};
	});
}

export interface OpenRewindListOptions {
	records: ReadonlyArray<WorkspaceSnapshotRecord>;
	onSelect: (n: number) => void;
	onClose: () => void;
}

export interface RewindListHandle extends ListOverlayHandle {
	setCounts(counts: RewindCounts): void;
}

export function openRewindListOverlay(tui: TUI, options: OpenRewindListOptions): RewindListHandle {
	const handle = openListOverlay(tui, {
		markerId: "rewind",
		title: "Rewind workspace files",
		items: rewindListItems(options.records, "pending"),
		layout: "split",
		emptyMessage: REWIND_EMPTY,
		hints: [{ key: "Enter", verb: "preview rewind" }],
		onSelect: (item) => options.onSelect(Number(item.id)),
		onClose: options.onClose,
	});
	return Object.assign(handle, {
		setCounts(counts: RewindCounts): void {
			handle.setItems(rewindListItems(options.records, counts));
		},
	});
}

/** Paths listed per group before the rest are counted. */
const REWIND_PATHS_SHOWN = 12;
const REWIND_VISIBLE_ROWS = 22;

/** The confirmation body: what is restored, what is removed, what is left alone. */
function formatRewindConfirmBody(
	record: WorkspaceSnapshotRecord,
	plan: RewindPlan,
	width: number,
	scroll: number,
): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const rows: string[] = [];
	const wrap = (token: Parameters<typeof theme.fg>[0], text: string): void => {
		rows.push(...wrapTextWithAnsi(theme.fg(token, text), contentWidth));
	};
	const changes = plan.restore.length + plan.remove.length;
	wrap(
		"annotation",
		`snapshot #${record.n} · ${dateLocal(record.at)} ${clockLocal(record.at)} · ${record.reason}${record.tool !== undefined ? ` before ${record.tool}` : ""}`,
	);
	if (changes === 0) {
		wrap("info", "The workspace already matches this snapshot. Nothing would change.");
	} else {
		wrap(
			"info",
			`Restores ${plan.restore.length} file${plan.restore.length === 1 ? "" : "s"} and removes ${plan.remove.length}. A pre-rewind snapshot is taken first, so /rewind can undo this.`,
		);
	}
	const group = (heading: string, paths: ReadonlyArray<string>): void => {
		if (paths.length === 0) return;
		rows.push(rule(theme, contentWidth));
		rows.push(theme.fg("groupHeading", heading));
		for (const rel of paths.slice(0, REWIND_PATHS_SHOWN)) wrap("menuDescription", `  ${rel}`);
		if (paths.length > REWIND_PATHS_SHOWN) wrap("annotation", `  and ${paths.length - REWIND_PATHS_SHOWN} more`);
	};
	group(`Restore (${plan.restore.length})`, plan.restore);
	group(`Remove (${plan.remove.length})`, plan.remove);
	group(
		`Left alone (${plan.kept.length})`,
		plan.kept.map((kept) => `${kept.path}: ${kept.why}`),
	);
	rows.push(rule(theme, contentWidth));
	wrap("annotation", "Gitignored files are never touched. Your Git index, HEAD and branches do not change.");

	const maxScroll = Math.max(0, rows.length - REWIND_VISIBLE_ROWS);
	const start = Math.max(0, Math.min(scroll, maxScroll));
	const shown = rows.slice(start, start + REWIND_VISIBLE_ROWS);
	if (rows.length > REWIND_VISIBLE_ROWS)
		shown.push(theme.fg("annotation", `(${start + 1}-${start + shown.length} of ${rows.length} lines)`));
	return shown;
}

export interface OpenRewindConfirmOptions {
	record: WorkspaceSnapshotRecord;
	plan: RewindPlan;
	columns: number;
	/** Enter: restore. Never called when the plan changes nothing. */
	onConfirm: () => void;
	/** Esc: nothing is written. */
	onCancel: () => void;
}

class RewindConfirmBody implements Component {
	scroll = 0;

	constructor(
		private readonly record: WorkspaceSnapshotRecord,
		private readonly plan: RewindPlan,
	) {}

	render(width: number): string[] {
		return formatRewindConfirmBody(this.record, this.plan, width, this.scroll);
	}

	invalidate(): void {}
}

export function openRewindConfirmOverlay(tui: TUI, options: OpenRewindConfirmOptions): OverlayHandle {
	const body = new RewindConfirmBody(options.record, options.plan);
	const actionable = options.plan.restore.length + options.plan.remove.length > 0;
	let settled = false;
	const focus = new FocusBox(body, {
		onInput: (data: string): void => {
			if (settled || isKeyRelease(data)) return;
			if (matchesKey(data, "up")) {
				body.scroll = Math.max(0, body.scroll - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				body.scroll += 1;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "enter") && actionable) {
				settled = true;
				options.onConfirm();
				return;
			}
			if (matchesKey(data, "escape")) {
				settled = true;
				options.onCancel();
			}
		},
	});
	return showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: Math.max(48, Math.min(110, options.columns - 4)),
		markerId: "rewind-confirm",
		title: `Rewind files to snapshot #${options.record.n}`,
		...(actionable ? { approval: true, awaitingInput: true, tone: "decisionCue" as const } : {}),
		footerHint: buildResponsiveHint(
			[...(actionable ? [{ key: "Enter", verb: "restore files" }] : []), { key: "↑↓", verb: "scroll" }],
			{ key: "Esc", verb: "cancel" },
		),
	});
}

/** One notice line for a finished rewind. */
export function formatRewindOutcome(outcome: RewindOutcome): {
	level: "success" | "warning" | "error";
	text: string;
} {
	if (outcome.kind === "unavailable") return { level: "error", text: `/rewind: ${outcome.reason}` };
	if (outcome.kind === "failed")
		return {
			level: "error",
			text: `/rewind failed: ${outcome.reason}. Snapshot #${outcome.preRewind.n} holds the files from before the rewind.`,
		};
	const left = outcome.kept.length + outcome.failed.length;
	return {
		level: outcome.failed.length > 0 ? "warning" : "success",
		text: `Rewound files to snapshot #${outcome.n}: restored ${outcome.restored.length}, removed ${outcome.removed.length}${left > 0 ? `, left ${left} alone` : ""}${outcome.failed.length > 0 ? ` (${outcome.failed.map((f) => `${f.path}: ${f.why}`).join("; ")})` : ""}. Snapshot #${outcome.preRewind.n} holds the files from before the rewind.`,
	};
}
