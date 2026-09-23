// The activity group is what keeps a forty-tool turn readable. It derives a one-line label and a
// tone from item statuses alone, decides whether the group opens itself, and names the currently
// running tool on the collapsed summary line so a silent run still tells the operator what is
// happening. No server field is added for any of it.

import type { TimelineItem } from "../../contracts/sessions.js";
import { notApproved, readWire } from "./tool-presentation.js";

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
		// Reasoning inside a group is context for the calls, not a step with an outcome of its own.
		if (item.kind === "thought") continue;
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
		total: running + waiting + completed + failed + canceled,
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
 * The disclosure policy. The group the turn is still working in stays open, one line per call, so the
 * operator can follow it without it opening and closing between calls; once prose follows, it folds
 * to its summary. Failures and waiting approvals stay open. Once the operator has toggled a group,
 * their choice wins forever, so `userOpen` is never reset.
 */
export function activityOpen(userOpen: boolean | null, settled: boolean, summary: ActivitySummary): boolean {
	if (userOpen !== null) return userOpen;
	return !settled || summary.failed > 0 || summary.waiting > 0;
}

type Phrase = (count: number) => string;
const counted =
	(verb: string, singular: string, pluralNoun = `${singular}s`): Phrase =>
	(count) =>
		`${verb} ${count} ${count === 1 ? singular : pluralNoun}`;
const DIGEST_PHRASES: Readonly<Record<string, Phrase>> = {
	read: counted("read", "file"),
	ls: counted("listed", "folder"),
	bash: counted("ran", "command"),
	run_script: counted("ran", "command"),
	safe_exec: counted("ran", "command"),
	git: counted("ran", "git command"),
	verify: counted("ran", "check"),
	grep: counted("ran", "search", "searches"),
	find: counted("ran", "search", "searches"),
	code_nav: counted("ran", "search", "searches"),
	web_fetch: counted("fetched", "page"),
	dispatch: counted("delegated", "task"),
	"change:done": counted("changed", "file"),
	"change:not-approved": (count) => `${plural(count, "change")} not approved`,
	"change:failed": (count) => `${plural(count, "change")} failed`,
	"change:stopped": (count) => `${plural(count, "change")} stopped`,
	"change:open": (count) => `${plural(count, "change")} in progress`,
};
const CHANGES = new Set(["edit", "write", "artifact"]);
/** Kinds whose phrase counts distinct paths rather than calls, so rereading one file reads as one file. */
const BY_PATH = new Set([
	"read",
	"change:done",
	"change:not-approved",
	"change:failed",
	"change:stopped",
	"change:open",
]);

/**
 * "changed 1 file" is a claim about the disk, so only a change call that completed without an error
 * earns it. Anything else says what became of the change, in the runtime's own terms. Edits and writes
 * share one phrase, so a turn that edits one file and writes another reads "changed 2 files".
 */
function changeKey(item: TimelineItem): string {
	const wire = readWire(item);
	if (item.status === "completed" && !wire.isError) return "change:done";
	if (notApproved(item, wire)) return "change:not-approved";
	if (item.status === "failed" || wire.isError) return "change:failed";
	if (item.status === "cancelled") return "change:stopped";
	return "change:open";
}

/**
 * What a group did, in words: "read 2 files, ran 1 command". Phrases follow first appearance, reads and
 * changes count distinct paths, and anything unnamed is counted as a tool rather than dropped.
 */
export function activityDigest(items: readonly TimelineItem[]): string {
	const order: string[] = [];
	const tallies = new Map<string, { calls: number; paths: Set<string> }>();
	for (const item of items) {
		if (item.kind === "thought") continue;
		const title = item.title ?? "";
		const key =
			item.kind === "notice"
				? "notice"
				: CHANGES.has(title)
					? changeKey(item)
					: DIGEST_PHRASES[title] === undefined
						? "other"
						: title;
		let tally = tallies.get(key);
		if (tally === undefined) {
			tally = { calls: 0, paths: new Set() };
			tallies.set(key, tally);
			order.push(key);
		}
		tally.calls += 1;
		const path = item.rawInput?.path;
		if (typeof path === "string" && path.length > 0) tally.paths.add(path);
	}
	return order
		.map((key) => {
			const tally = tallies.get(key);
			if (tally === undefined) return "";
			if (key === "notice") return `${tally.calls} ${tally.calls === 1 ? "approval step" : "approval steps"}`;
			if (key === "other") return `used ${tally.calls} ${tally.calls === 1 ? "other tool" : "other tools"}`;
			const count = BY_PATH.has(key) && tally.paths.size > 0 ? tally.paths.size : tally.calls;
			return DIGEST_PHRASES[key]?.(count) ?? "";
		})
		.filter((phrase) => phrase.length > 0)
		.join(", ");
}

/** The one fact that makes a collapsed group still informative. */
export function runningItem(items: readonly TimelineItem[]): TimelineItem | null {
	return items.find((item) => item.kind !== "thought" && item.status === "in_progress") ?? null;
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
