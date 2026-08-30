/**
 * Conversation projection over the session timeline.
 *
 * The timeline stays the authoritative, forensic record. This module groups its
 * items by turn so the working surface can show the request, the response,
 * compact activity, and the outcome without inventing any state: every label
 * here is derived from item kinds and statuses the protocol already carries.
 */

import type { WireClioPhase, WireEventSource, WirePendingPermission, WireTimelineItem } from "./protocol.ts";

/** Provenance wording shared with the Session Timeline cards. */
export const SOURCE_LABELS: Readonly<Record<WireEventSource, string>> = {
	"reported-by-clio": "Reported by Clio Coder",
	"observed-on-acp": "Observed on ACP",
	"observed-by-workbench": "Observed by desktop",
	"replayed-from-clio": "Replayed from Clio Coder",
};

export type ChatSegment =
	| Readonly<{ kind: "response"; item: WireTimelineItem }>
	| Readonly<{ kind: "reasoning"; item: WireTimelineItem }>
	| Readonly<{ kind: "activity"; items: readonly WireTimelineItem[] }>;

export interface ChatTurn {
	readonly turnId: string;
	readonly origin: "live" | "replay";
	readonly request: WireTimelineItem | null;
	readonly segments: readonly ChatSegment[];
	/** The outcome or failure card, once Clio Coder ended the turn. */
	readonly outcome: WireTimelineItem | null;
	readonly items: readonly WireTimelineItem[];
	/** True when nothing in this turn can still change. */
	readonly settled: boolean;
}

function sameItems(previous: readonly WireTimelineItem[], next: readonly WireTimelineItem[]): boolean {
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) {
		if (previous[index] !== next[index]) return false;
	}
	return true;
}

function buildTurn(turnId: string, items: readonly WireTimelineItem[]): ChatTurn {
	let request: WireTimelineItem | null = null;
	let outcome: WireTimelineItem | null = null;
	const segments: ChatSegment[] = [];
	let activity: WireTimelineItem[] | null = null;
	const flushActivity = () => {
		if (activity !== null && activity.length > 0) segments.push({ kind: "activity", items: activity });
		activity = null;
	};
	for (const item of items) {
		switch (item.kind) {
			case "request":
				request = item;
				break;
			case "outcome":
			case "failure":
				flushActivity();
				outcome = item;
				break;
			case "narrative":
				flushActivity();
				segments.push({ kind: "response", item });
				break;
			case "thought":
				flushActivity();
				segments.push({ kind: "reasoning", item });
				break;
			case "tool":
			case "approval":
			case "loop":
				activity ??= [];
				activity.push(item);
				break;
		}
	}
	flushActivity();
	const origin = items[0]?.origin ?? "live";
	return {
		turnId,
		origin,
		request,
		segments,
		outcome,
		items,
		settled: outcome !== null || origin === "replay",
	};
}

/**
 * Groups timeline items into turns. A turn whose items are all identical to
 * the previous grouping keeps its object identity, so settled turns never
 * re-render while a later one streams.
 */
export function groupTurns(
	timeline: readonly WireTimelineItem[],
	previous: readonly ChatTurn[] = [],
): readonly ChatTurn[] {
	const order: string[] = [];
	const byTurn = new Map<string, WireTimelineItem[]>();
	for (const item of timeline) {
		let bucket = byTurn.get(item.turnId);
		if (bucket === undefined) {
			bucket = [];
			byTurn.set(item.turnId, bucket);
			order.push(item.turnId);
		}
		bucket.push(item);
	}
	const previousByTurn = new Map(previous.map((turn) => [turn.turnId, turn] as const));
	let unchanged = previous.length === order.length;
	const turns = order.map((turnId, index) => {
		const items = byTurn.get(turnId) ?? [];
		const prior = previousByTurn.get(turnId);
		if (prior !== undefined && sameItems(prior.items, items)) {
			if (previous[index] !== prior) unchanged = false;
			return prior;
		}
		unchanged = false;
		return buildTurn(turnId, items);
	});
	return unchanged ? previous : turns;
}

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

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A one-line description of an activity group, from item statuses only. */
export function summarizeActivity(items: readonly WireTimelineItem[]): ActivitySummary {
	let running = 0;
	let waiting = 0;
	let completed = 0;
	let failed = 0;
	let canceled = 0;
	let onlyTools = true;
	for (const item of items) {
		if (item.kind !== "tool") onlyTools = false;
		switch (item.status) {
			case "active":
			case "queued":
				running += 1;
				break;
			case "waiting":
				waiting += 1;
				break;
			case "failed":
				failed += 1;
				break;
			case "canceled":
				canceled += 1;
				break;
			case "complete":
			case "replayed":
				completed += 1;
				break;
		}
	}
	const total = items.length;
	const noun = onlyTools ? "tool" : "step";
	let label: string;
	let tone: ActivityTone;
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
		total,
		running,
		waiting,
		completed,
		failed,
		canceled,
		attention: waiting > 0 || running > 0 || failed > 0,
	};
}

export type LiveState =
	| "starting"
	| "thinking"
	| "writing"
	| "acting"
	| "waiting"
	| "stopping"
	| "done"
	| "failed"
	| "stopped";

export interface LiveStatus {
	readonly state: LiveState;
	readonly label: string;
	/** The exact Clio Coder-reported title behind the state, when one exists. */
	readonly detail: string | null;
}

/** What Clio Coder is doing in this turn, using only phase and item facts. */
export function liveStatus(
	turn: ChatTurn,
	phase: WireClioPhase,
	pendingPermission: WirePendingPermission | null,
): LiveStatus {
	if (turn.outcome !== null) {
		if (turn.outcome.kind === "failure" || turn.outcome.status === "failed") {
			return { state: "failed", label: "Failed", detail: turn.outcome.summary };
		}
		if (turn.outcome.status === "canceled") return { state: "stopped", label: "Stopped", detail: null };
		return { state: "done", label: "Complete", detail: null };
	}
	if (turn.origin === "replay") return { state: "done", label: "Earlier record", detail: null };
	if (phase === "awaiting-approval" && pendingPermission !== null) {
		return { state: "waiting", label: "Waiting for your approval", detail: pendingPermission.title };
	}
	if (phase === "cancelling") return { state: "stopping", label: "Stopping", detail: null };
	if (phase === "failed" || phase === "closed") return { state: "failed", label: "Failed", detail: null };
	const last = turn.items.at(-1);
	if (last === undefined || last.kind === "request") return { state: "starting", label: "Starting", detail: null };
	if (last.kind === "tool" && last.status === "active") {
		return { state: "acting", label: "Running", detail: last.summary };
	}
	if (last.kind === "thought") return { state: "thinking", label: "Thinking", detail: null };
	if (last.kind === "narrative") return { state: "writing", label: "Writing", detail: null };
	if (last.kind === "approval" && last.status === "waiting") {
		return { state: "waiting", label: "Waiting for your approval", detail: last.title };
	}
	return { state: "acting", label: "Working", detail: null };
}

export const TOOL_STATUS_LABELS: Readonly<Record<WireTimelineItem["status"], string>> = {
	queued: "queued",
	active: "running",
	waiting: "waiting",
	complete: "done",
	canceled: "stopped",
	failed: "failed",
	replayed: "earlier",
};
