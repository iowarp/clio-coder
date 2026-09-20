// The conversation projection. `SessionSnapshot.timeline` is a flat, ordered list of items that
// carry a `turnId`; a reader needs it as turns, and inside a turn as an interleaving of prose,
// reasoning and *runs* of tool activity, so a turn that ran fourteen tools between two paragraphs
// reads as paragraph, one collapsed activity group, paragraph.
//
// The referential-identity contract is the point of this module. A turn whose items are
// element-wise identical to the previous grouping keeps its object identity, and the whole array
// keeps its identity when no turn changed, so a settled turn never re-renders while a later turn
// streams.

import type { TimelineItem, Turn } from "../../contracts/sessions.js";

export type ChatSegment =
	| Readonly<{ kind: "response"; item: TimelineItem }>
	| Readonly<{ kind: "reasoning"; item: TimelineItem }>
	| Readonly<{ kind: "activity"; items: readonly TimelineItem[] }>;

export interface ChatTurn {
	readonly turnId: string;
	readonly origin: "live" | "replay";
	readonly request: TimelineItem | null;
	readonly segments: readonly ChatSegment[];
	readonly items: readonly TimelineItem[];
	/** True when nothing in this turn can still change. */
	readonly settled: boolean;
}

/** The `turnId → status` map `groupTurns` reads. Build it from `SessionSnapshot.turns`. */
export type TurnStatuses = ReadonlyMap<string, Turn["status"]>;

export function turnStatuses(turns: readonly Turn[]): TurnStatuses {
	return new Map(turns.map((turn) => [turn.id, turn.status] as const));
}

function sameItems(previous: readonly TimelineItem[], next: readonly TimelineItem[]): boolean {
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) if (previous[index] !== next[index]) return false;
	return true;
}

/**
 * A replayed turn is history and can never change again. A live turn is settled once its `Turn` row
 * reports a terminal status; a live turn with no row yet has not started reporting and is still
 * open. The reuse test below must ask this same question, or a live turn missing its row rebuilds
 * on every call and loses the identity the memo depends on.
 */
function isSettled(items: readonly TimelineItem[], status: Turn["status"] | undefined): boolean {
	return (items[0]?.origin ?? "live") === "replay" || (status !== undefined && status !== "running");
}

function buildTurn(turnId: string, items: readonly TimelineItem[], status: Turn["status"] | undefined): ChatTurn {
	let request: TimelineItem | null = null;
	const segments: ChatSegment[] = [];
	let activity: TimelineItem[] | null = null;
	const flush = () => {
		if (activity !== null && activity.length > 0) segments.push({ kind: "activity", items: activity });
		activity = null;
	};
	for (const item of items) {
		switch (item.kind) {
			case "user":
				request = item;
				break;
			case "text":
				flush();
				segments.push({ kind: "response", item });
				break;
			case "thought":
				flush();
				segments.push({ kind: "reasoning", item });
				break;
			case "tool":
			case "notice":
				if (activity === null) activity = [];
				activity.push(item);
				break;
		}
	}
	flush();
	return {
		turnId,
		origin: items[0]?.origin ?? "live",
		request,
		segments,
		items,
		settled: isSettled(items, status),
	};
}

/**
 * Groups timeline items into turns, in first-appearance order. A turn whose items are all identical
 * to the previous grouping keeps its object identity, and the returned array is the previous array
 * itself when every turn was reused in the same position.
 */
export function groupTurns(
	timeline: readonly TimelineItem[],
	statuses: TurnStatuses,
	previous: readonly ChatTurn[] = [],
): readonly ChatTurn[] {
	const order: string[] = [];
	const byTurn = new Map<string, TimelineItem[]>();
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
		const status = statuses.get(turnId);
		if (prior !== undefined && sameItems(prior.items, items) && prior.settled === isSettled(items, status)) {
			if (previous[index] !== prior) unchanged = false;
			return prior;
		}
		unchanged = false;
		return buildTurn(turnId, items, status);
	});
	return unchanged ? previous : turns;
}

/** The turn still producing output, which is the only one a live status chip belongs to. */
export function activeTurn(turns: readonly ChatTurn[]): ChatTurn | null {
	const last = turns.at(-1);
	return last !== undefined && !last.settled ? last : null;
}

/**
 * The memo comparator for a turn view. A settled turn is immune to the clock tick and to a
 * permission landing elsewhere in the conversation, which is what buys the render savings; pass
 * `nowMs={turn.settled ? 0 : nowMs}` so the once-a-second tick cannot reach it either.
 */
export function sameTurnView<Props extends { turn: ChatTurn; pendingPermissionId: string | null; nowMs: number }>(
	previous: Props,
	next: Props,
): boolean {
	if (previous.turn !== next.turn) return false;
	if (previous.turn.settled) return true;
	return previous.pendingPermissionId === next.pendingPermissionId && previous.nowMs === next.nowMs;
}
