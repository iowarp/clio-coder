/**
 * Turn projection shared by the host and the renderer.
 *
 * The host applies every turn event here before it broadcasts it, so a browser
 * that reloads mid-session receives the same timeline it would have built by
 * watching the stream. The renderer applies the same function to live events.
 * No React, no host APIs: only protocol DTOs in, protocol DTOs out.
 */

import {
	MAX_WIRE_TIMELINE_ENTRIES,
	type PermissionResolution,
	type ServerEventKind,
	type ServerEventPayloadByKind,
	type TurnOutcome,
	type WireActiveTurn,
	type WirePendingPermission,
	type WireTimelineItem,
} from "./protocol.ts";

export type TurnEventKind = Extract<
	ServerEventKind,
	| "turn.started"
	| "turn.text"
	| "turn.thought"
	| "turn.tool"
	| "turn.loop"
	| "turn.permission.requested"
	| "turn.permission.resolved"
	| "turn.terminal"
>;

export type TurnEventInput = {
	[K in TurnEventKind]: Readonly<{
		kind: K;
		turnId: string;
		payload: ServerEventPayloadByKind[K];
	}>;
}[TurnEventKind];

export interface TurnProjection {
	readonly timeline: readonly WireTimelineItem[];
	readonly timelineTruncated: boolean;
	readonly activeTurn: WireActiveTurn | null;
	readonly pendingPermission: WirePendingPermission | null;
	/** Turn identity of the most recent `turn.started`, used to attribute origin to later items. */
	readonly currentTurn: Readonly<{ turnId: string; origin: "live" | "replay"; startedAt: string | null }> | null;
	/**
	 * Monotonic ordinal of the newest timeline item. New items take `ordinal + 1`
	 * as their `sequence`, so identifiers never collide after the timeline is
	 * bounded and the host and renderer mint identical ids without a wire counter.
	 */
	readonly ordinal: number;
}

export const emptyTurnProjection: TurnProjection = {
	timeline: [],
	timelineTruncated: false,
	activeTurn: null,
	pendingPermission: null,
	currentTurn: null,
	ordinal: 0,
};

/**
 * Rebuilds projection bookkeeping from a wire workspace so a reloaded renderer
 * continues exactly where the host is. `sequence` is present on every host-minted
 * item, so the ordinal is its maximum.
 */
export function restoreTurnProjection(
	input: Readonly<{
		timeline: readonly WireTimelineItem[];
		timelineTruncated: boolean;
		activeTurn: WireActiveTurn | null;
		pendingPermission: WirePendingPermission | null;
	}>,
): TurnProjection {
	const last = input.timeline.at(-1);
	const currentTurn = input.activeTurn !== null
		? { turnId: input.activeTurn.turnId, origin: "live" as const, startedAt: input.activeTurn.startedAt }
		: last === undefined
		? null
		: {
			turnId: last.turnId,
			origin: last.origin,
			startedAt: input.timeline.find((item) => item.turnId === last.turnId)?.startedAt ?? last.startedAt,
		};
	return {
		timeline: input.timeline,
		timelineTruncated: input.timelineTruncated,
		activeTurn: input.activeTurn,
		pendingPermission: input.pendingPermission,
		currentTurn,
		ordinal: input.timeline.reduce((maximum, item) => Math.max(maximum, item.sequence ?? 0), 0),
	};
}

const encoder = new TextEncoder();
export const MAX_TIMELINE_STREAM_BYTES = 64 * 1024;
export const TIMELINE_STREAM_TRUNCATION_MARKER = "\n[… stream truncated by Workbench …]";

function boundUtf8WithMarker(value: string, maximumBytes: number, marker: string): string {
	if (encoder.encode(value).byteLength <= maximumBytes) return value;
	const markerBytes = encoder.encode(marker).byteLength;
	const prefixBudget = maximumBytes - markerBytes;
	const characters: string[] = [];
	let usedBytes = 0;
	for (const character of value) {
		const characterBytes = encoder.encode(character).byteLength;
		if (usedBytes + characterBytes > prefixBudget) break;
		characters.push(character);
		usedBytes += characterBytes;
	}
	return `${characters.join("")}${marker}`;
}

function appendBoundedStream(prior: string, next: string): string {
	if (prior.endsWith(TIMELINE_STREAM_TRUNCATION_MARKER)) return prior;
	return boundUtf8WithMarker(`${prior}${next}`, MAX_TIMELINE_STREAM_BYTES, TIMELINE_STREAM_TRUNCATION_MARKER);
}

function itemId(turnId: string, kind: string, entityId?: string): string {
	return `${turnId}:${kind}${entityId === undefined ? "" : `:${entityId}`}`;
}

function boundedTimeline(
	timeline: readonly WireTimelineItem[],
	truncated: boolean,
): Readonly<{ timeline: readonly WireTimelineItem[]; truncated: boolean }> {
	if (timeline.length <= MAX_WIRE_TIMELINE_ENTRIES) return { timeline, truncated };
	return { timeline: timeline.slice(timeline.length - MAX_WIRE_TIMELINE_ENTRIES), truncated: true };
}

function upsert(
	state: TurnProjection,
	item: WireTimelineItem,
	mode: "replace" | "append-summary" = "replace",
): TurnProjection {
	const index = state.timeline.findIndex((candidate) => candidate.id === item.id);
	if (index < 0) {
		const ordinal = state.ordinal + 1;
		const bounded = boundedTimeline([...state.timeline, { ...item, sequence: ordinal }], state.timelineTruncated);
		return { ...state, timeline: bounded.timeline, timelineTruncated: bounded.truncated, ordinal };
	}
	const prior = state.timeline[index]!;
	const updated: WireTimelineItem = mode === "append-summary"
		? {
			...prior,
			...item,
			summary: appendBoundedStream(prior.summary, item.summary),
			startedAt: prior.startedAt,
			...(prior.sequence === undefined ? {} : { sequence: prior.sequence }),
		}
		: {
			...prior,
			...item,
			startedAt: prior.startedAt,
			...(prior.sequence === undefined ? {} : { sequence: prior.sequence }),
		};
	return {
		...state,
		timeline: state.timeline.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate),
	};
}

function toolStatus(status: ServerEventPayloadByKind["turn.tool"]["status"]): WireTimelineItem["status"] {
	switch (status) {
		case "in_progress":
			return "active";
		case "completed":
			return "complete";
		case "failed":
			return "failed";
		case "canceled":
			return "canceled";
	}
}

export function resolutionSummary(decision: PermissionResolution): string {
	switch (decision) {
		case "allow-once":
			return "Allowed once by the operator.";
		case "reject":
			return "Rejected by the operator. Clio was told no.";
		case "cancelled":
			return "Withdrawn when the turn was cancelled. Clio was not told no.";
		case "unanswered":
			return "Nobody answered. The turn was stopped; Clio was not told no.";
		case "disconnect":
			return "Withdrawn when the local connection closed. Clio was not told no.";
	}
}

function resolutionStatus(decision: PermissionResolution): WireTimelineItem["status"] {
	return decision === "allow-once" ? "complete" : "canceled";
}

function outcomeStatus(outcome: TurnOutcome): WireTimelineItem["status"] {
	return outcome === "completed" ? "complete" : outcome === "canceled" ? "canceled" : "failed";
}

function settleTurn(
	timeline: readonly WireTimelineItem[],
	turnId: string,
	outcome: TurnOutcome,
	endedAt: string,
): readonly WireTimelineItem[] {
	const status = outcomeStatus(outcome);
	return timeline.map((item) =>
		item.turnId === turnId && (item.status === "active" || item.status === "waiting")
			? { ...item, status, endedAt }
			: item
	);
}

function formatPath(path: Readonly<{ segments: readonly string[] }>): string {
	return path.segments.length === 0 ? "/" : path.segments.join("/");
}

/**
 * Applies one turn event. `now` is the host clock at emission time and is
 * recorded verbatim so both sides agree on when a card started and ended.
 */
export function applyTurnEvent(state: TurnProjection, event: TurnEventInput, now: string): TurnProjection {
	const origin = state.currentTurn?.turnId === event.turnId ? state.currentTurn.origin : "live";
	const base = {
		turnId: event.turnId,
		origin,
		startedAt: origin === "replay" ? null : now,
	} as const;
	switch (event.kind) {
		case "turn.started": {
			let activeTurn = state.activeTurn;
			if (event.payload.origin === "live") {
				if (event.payload.startedAt === null) throw new TypeError("A live turn requires a start time.");
				activeTurn = {
					turnId: event.turnId,
					startedAt: event.payload.startedAt,
					toolCalls: 0,
					lastToolTitle: null,
					repeatedShapes: 0,
				};
			}
			const started: TurnProjection = {
				...state,
				currentTurn: { turnId: event.turnId, origin: event.payload.origin, startedAt: event.payload.startedAt },
				pendingPermission: null,
				activeTurn,
			};
			return upsert(started, {
				id: itemId(event.turnId, "request"),
				kind: "request",
				title: event.payload.origin === "replay" ? "Earlier request" : "Request",
				summary: event.payload.promptSummary,
				status: event.payload.origin === "replay" ? "replayed" : "active",
				turnId: event.turnId,
				origin: event.payload.origin,
				startedAt: event.payload.startedAt,
				source: event.payload.source,
			});
		}
		case "turn.text":
		case "turn.thought": {
			const isThought = event.kind === "turn.thought";
			const streamKind = isThought ? "thought" : "text";
			const streamPrefix = `${itemId(event.turnId, streamKind)}:`;
			const prior = state.timeline.at(-1);
			const streamId = prior?.id.startsWith(streamPrefix) ? prior.id : `${streamPrefix}${state.ordinal + 1}`;
			return upsert(state, {
				id: streamId,
				kind: isThought ? "thought" : "narrative",
				title: isThought ? "Reasoning" : "Clio",
				summary: event.payload.text,
				status: origin === "replay" ? "replayed" : "complete",
				...base,
				source: event.payload.source,
			}, "append-summary");
		}
		case "turn.tool": {
			const locations = event.payload.locations.map(formatPath);
			const detail = locations.length === 0 ? event.payload.kind : `${event.payload.kind} · ${locations.join(", ")}`;
			const projectedStatus = toolStatus(event.payload.status);
			const status = origin === "replay" && projectedStatus === "active" ? "replayed" : projectedStatus;
			const existing = state.timeline.find((item) =>
				item.id === itemId(event.turnId, "tool", event.payload.toolCallId)
			);
			const activeTurn = state.activeTurn?.turnId === event.turnId
				? {
					...state.activeTurn,
					toolCalls: existing === undefined ? state.activeTurn.toolCalls + 1 : state.activeTurn.toolCalls,
					// Clio's own title rather than the kind label, because during a silent
					// run this line is the only place the operator learns which command is
					// running. It is the same string the tool card already shows.
					lastToolTitle: event.payload.summary.trim().length > 0 ? event.payload.summary : event.payload.title,
				}
				: state.activeTurn;
			return upsert({ ...state, activeTurn }, {
				id: itemId(event.turnId, "tool", event.payload.toolCallId),
				kind: "tool",
				title: event.payload.title,
				summary: event.payload.summary,
				detail,
				status,
				...base,
				...(origin === "live" && status !== "active" ? { endedAt: now } : {}),
				source: event.payload.source,
			});
		}
		case "turn.loop": {
			const activeTurn = state.activeTurn?.turnId === event.turnId
				? { ...state.activeTurn, repeatedShapes: state.activeTurn.repeatedShapes + 1 }
				: state.activeTurn;
			return upsert({ ...state, activeTurn }, {
				id: itemId(event.turnId, "loop", String(state.ordinal + 1)),
				kind: "loop",
				title: `Clio blocked a repeated ${event.payload.tool} call`,
				summary:
					`Repeated ${event.payload.repeatCount} times; ${event.payload.blocksThisTurn} of ${event.payload.budget} blocks used this turn (${event.payload.disposition}).${
						event.payload.interrupted ? " Clio interrupted the turn." : ""
					}`,
				status: "complete",
				...base,
				endedAt: now,
				source: event.payload.source,
			});
		}
		case "turn.permission.requested": {
			const locations = event.payload.locations.map(formatPath);
			const target = locations.length === 0 ? "this turn" : locations.join(", ");
			return upsert({ ...state, pendingPermission: event.payload }, {
				id: itemId(event.turnId, "permission", event.payload.permissionId),
				kind: "approval",
				title: event.payload.title,
				summary: `${event.payload.kind} permission requested for ${target}.`,
				detail: `Allow once for ${target}`,
				status: "waiting",
				...base,
				source: event.payload.source,
			});
		}
		case "turn.permission.resolved": {
			const id = itemId(event.turnId, "permission", event.payload.permissionId);
			const existing = state.timeline.find((item) => item.id === id);
			const pendingPermission = state.pendingPermission?.permissionId === event.payload.permissionId
				? null
				: state.pendingPermission;
			return upsert({ ...state, pendingPermission }, {
				id,
				kind: "approval",
				title: existing?.title ?? "Permission resolved",
				summary: resolutionSummary(event.payload.decision),
				...(existing?.detail === undefined ? {} : { detail: existing.detail }),
				status: resolutionStatus(event.payload.decision),
				...base,
				endedAt: now,
				source: event.payload.source,
			});
		}
		case "turn.terminal": {
			const settled = settleTurn(state.timeline, event.turnId, event.payload.outcome, now);
			const title = event.payload.outcome === "completed"
				? "Turn complete"
				: event.payload.outcome === "canceled"
				? "Turn stopped"
				: "Turn failed";
			const next: TurnProjection = {
				...state,
				timeline: settled,
				activeTurn: state.activeTurn?.turnId === event.turnId ? null : state.activeTurn,
				pendingPermission: null,
			};
			return upsert(next, {
				id: itemId(event.turnId, "terminal"),
				kind: event.payload.outcome === "failed" ? "failure" : "outcome",
				title,
				summary: event.payload.summary,
				detail: event.payload.stopReason ?? event.payload.code,
				status: outcomeStatus(event.payload.outcome),
				...base,
				endedAt: now,
				...(event.payload.usage === undefined ? {} : { usage: event.payload.usage }),
				source: event.payload.source,
			});
		}
	}
}
