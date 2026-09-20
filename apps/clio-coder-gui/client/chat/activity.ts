// The activity group is what keeps a forty-tool turn readable. It derives a one-line label and a
// tone from item statuses alone, decides whether the group opens itself, and names the currently
// running tool on the collapsed summary line so a silent run still tells the operator what is
// happening. No server field is added for any of it.

import type { TimelineItem } from "../../contracts/sessions.js";

export type ActivityTone = "neutral" | "info" | "action" | "success" | "warning" | "error";

export interface ActivitySummary {
	readonly label: string;
	readonly tone: ActivityTone;
	readonly total: number;
	readonly running: number;
	readonly waiting: number;
	readonly completed: number;
	readonly failed: number;
	readonly canceled: number;
	/** True when something in the group needs the operator's eyes right now. */
	readonly attention: boolean;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * `TimelineItem.status` is an open string carrying the raw ACP status, so this maps the values the
 * harness actually emits and treats anything else as completed, which is the only assumption that
 * cannot strand a group in a permanently running state.
 */
export function summarizeActivity(items: readonly TimelineItem[]): ActivitySummary {
	let running = 0,
		waiting = 0,
		completed = 0,
		failed = 0,
		canceled = 0,
		onlyTools = true;
	for (const item of items) {
		if (item.kind !== "tool") onlyTools = false;
		switch (item.status) {
			case "in_progress":
			case "pending":
				running += 1;
				break;
			case "escalated":
				waiting += 1;
				break;
			case "failed":
				failed += 1;
				break;
			case "cancelled":
			case "rejected":
			case "expired":
				canceled += 1;
				break;
			default:
				completed += 1;
				break;
		}
	}
	const noun = onlyTools ? "tool" : "step";
	let label: string, tone: ActivityTone;
	if (waiting > 0) {
		label = "Approval needed";
		tone = "warning";
	} else if (running > 0) {
		label = `${plural(running, noun)} running${completed > 0 ? ` · ${completed} done` : ""}`;
		tone = "action";
	} else if (failed > 0) {
		label = `${plural(failed, noun)} failed${completed > 0 ? ` · ${completed} completed` : ""}`;
		tone = "error";
	} else if (canceled > 0 && completed === 0) {
		label = `${plural(canceled, noun)} stopped`;
		tone = "neutral";
	} else {
		label = `${plural(completed, noun)} completed${canceled > 0 ? ` · ${canceled} stopped` : ""}`;
		tone = "success";
	}
	return {
		label,
		tone,
		total: items.length,
		running,
		waiting,
		completed,
		failed,
		canceled,
		attention: waiting > 0 || running > 0 || failed > 0,
	};
}

export const TOOL_STATUS_LABELS: Readonly<Record<string, string>> = {
	pending: "queued",
	in_progress: "running",
	completed: "done",
	cancelled: "stopped",
	failed: "failed",
	escalated: "waiting",
	allowed: "allowed",
	rejected: "rejected",
	expired: "expired",
};

export const STATUS_GLYPHS: Readonly<Record<string, string>> = {
	pending: "…",
	in_progress: "◐",
	escalated: "!",
	completed: "✓",
	cancelled: "–",
	failed: "✕",
	allowed: "✓",
	rejected: "✕",
	expired: "–",
};

/** An unmapped status is reported verbatim rather than hidden, because it came off the wire. */
export const toolStatusLabel = (status: string): string => TOOL_STATUS_LABELS[status] ?? status;
export const statusGlyph = (status: string): string => STATUS_GLYPHS[status] ?? "·";

/** The glyph for the collapsed summary line. Attention outranks progress, which outranks failure. */
export function activityGlyph(summary: ActivitySummary): string {
	if (summary.waiting > 0) return "!";
	if (summary.running > 0) return "◐";
	if (summary.failed > 0) return "✕";
	return "✓";
}

/**
 * The disclosure policy. The group opens itself only while something still needs attention; once
 * the operator has toggled it, their choice wins forever, so `userOpen` is never reset.
 */
export function activityOpen(userOpen: boolean | null, settled: boolean, summary: ActivitySummary): boolean {
	if (userOpen !== null) return userOpen;
	return (!settled && summary.attention) || summary.failed > 0 || summary.waiting > 0;
}

/** The one fact that makes a collapsed group still informative. */
export function runningItem(items: readonly TimelineItem[]): TimelineItem | null {
	return items.find((item) => item.status === "in_progress") ?? null;
}

/** The left-hand kind column of a row. A notice says which kind of notice it is. */
export function activityKindLabel(item: TimelineItem): string {
	if (item.kind === "notice") return item.toolKind === "safety" ? "safety" : "approval";
	return item.toolKind ?? "tool";
}

/**
 * Elapsed is printed only while a row is running and has been for at least two seconds, so a short
 * call does not flicker a timer on and off.
 */
export function showElapsed(item: TimelineItem, elapsedMs: number): boolean {
	return item.status === "in_progress" && elapsedMs >= 2000;
}

type ProvenanceEntry = NonNullable<TimelineItem["provenance"]>[number];

/**
 * The agent attribution tag. The last entry wins, so a delegated worker outranks the orchestrator
 * that dispatched it, and a call with no worker in its chain stays attributed to the product and
 * gets no tag at all.
 */
export function workerLabel(provenance: readonly ProvenanceEntry[] | undefined): string | null {
	const last = provenance?.at(-1);
	if (last === undefined || last.role !== "worker") return null;
	return last.node == null ? last.agentId : `${last.agentId} · ${last.node}`;
}

export const WORKER_LABEL_TITLE = "Reported by Clio Coder as the agent that ran this call";
