import type { SessionDelta, SessionSnapshot, TimelineItem } from "./sessions.js";

const encoder = new TextEncoder();
const MARKER = "\n[… stream truncated …]";
const STREAM_LIMIT = 65536;
const MARKER_BYTES = encoder.encode(MARKER).byteLength;
const MAX_TIMELINE_ITEMS = 2048;
const MAX_TIMELINE_BYTES = 2 * 1024 * 1024;

/** Every UTF-8 measurement passes through one meter so the suite can prove retention accounting stays O(1) per delta. */
export const encodeMeter = { bytes: 0, calls: 0 };
function measure(value: string) {
	encodeMeter.calls++;
	encodeMeter.bytes += value.length;
	return encoder.encode(value).byteLength;
}

type Bounded = { text: string; bytes: number };
function bound(value: string, limit: number): Bounded {
	const bytes = measure(value);
	if (bytes <= limit) return { text: value, bytes };
	const budget = limit - MARKER_BYTES;
	let used = 0,
		output = "";
	for (const character of value) {
		const size = measure(character);
		if (used + size > budget) break;
		output += character;
		used += size;
	}
	return { text: output + MARKER, bytes: used + MARKER_BYTES };
}
export function boundedText(value: string, limit = STREAM_LIMIT) {
	return bound(value, limit).text;
}

/**
 * Retention accounting is carried forward rather than recomputed: a streamed turn emits thousands of deltas, and
 * re-serializing the timeline (or the growing run inside it) on each one is quadratic in the length of the turn.
 * Costs key on object identity, so a snapshot that arrives over the wire is measured once and then stays incremental.
 */
type Cost = { text: number; json: number };
const costs = new WeakMap<TimelineItem, Cost>();
const totals = new WeakMap<readonly TimelineItem[], number>();
function itemCost(item: TimelineItem) {
	const known = costs.get(item);
	if (known) return known;
	const cost: Cost = { text: measure(item.text), json: measure(JSON.stringify(item)) + 1 };
	costs.set(item, cost);
	return cost;
}
function timelineBytes(timeline: readonly TimelineItem[]) {
	const known = totals.get(timeline);
	if (known !== undefined) return known;
	let bytes = 0;
	for (const item of timeline) bytes += itemCost(item).json;
	totals.set(timeline, bytes);
	return bytes;
}

export function emptySession(id: string, workspaceId: string): SessionSnapshot {
	return {
		id,
		workspaceId,
		state: "starting",
		revision: 0,
		timeline: [],
		timelineTruncated: false,
		turns: [],
		recoveredOrphan: false,
		label: null,
		permissions: [],
		fleet: [],
		health: [],
	};
}
type NarrativeKind = "text" | "thought";
const provenanceKey = (provenance: TimelineItem["provenance"]) =>
	provenance ? `:${provenance.map((agent) => `${agent.agentId}:${agent.runId ?? ""}`).join("|")}` : "";

/**
 * The id a narrative chunk appends to. Chunks from one agent stream keep extending the same item until
 * something else happens in the turn: a tool call, a notice, or the same agent switching between reasoning
 * and prose. After that break the agent is writing a new passage, and appending it to the item above the tool
 * calls would print text written after them before them. Another agent's narrative is not a break, so
 * interleaved workers still read as one passage each. Ids derive only from the timeline, so the server's
 * snapshot and a browser applying the same deltas agree on them.
 */
function narrativeId(timeline: readonly TimelineItem[], turnId: string, kind: NarrativeKind, identity: string): string {
	const base = `${turnId}:${kind}${identity}`;
	let broken = false;
	for (let index = timeline.length - 1; index >= 0; index -= 1) {
		const item = timeline[index];
		if (item === undefined || item.turnId !== turnId) break;
		if (item.id === base || item.id.startsWith(`${base}#`)) {
			if (!broken) return item.id;
			return `${base}#${(timeline.at(-1)?.sequence ?? 0) + 1}`;
		}
		if (item.kind === "tool" || item.kind === "notice") broken = true;
		else if ((item.kind === "text" || item.kind === "thought") && provenanceKey(item.provenance) === identity)
			broken = true;
	}
	return base;
}

export function applySessionDelta(current: SessionSnapshot, event: SessionDelta): SessionSnapshot {
	if (event.payload.resource !== current.id || event.payload.revision <= current.revision) return current;
	if (event.payload.revision !== current.revision + 1) throw new Error("Session revision gap requires a snapshot.");
	let state: SessionSnapshot = { ...current, revision: event.payload.revision };
	const upsert = (item: Omit<TimelineItem, "sequence">, append = false) => {
		const previous = state.timeline.find((row) => row.id === item.id);
		const sequence = previous?.sequence ?? (state.timeline.at(-1)?.sequence ?? 0) + 1;
		const prior = previous ? itemCost(previous) : undefined;
		let text: string,
			textBytes: number,
			// A plain append changes only the run's text, so the item's serialized cost grows by the escaped chunk alone.
			jsonGrowth: number | undefined;
		if (append && previous && prior) {
			if (previous.text.endsWith(MARKER)) {
				text = previous.text;
				textBytes = prior.text;
				jsonGrowth = 0;
			} else {
				const added = measure(item.text);
				if (prior.text + added <= STREAM_LIMIT) {
					text = previous.text + item.text;
					textBytes = prior.text + added;
					jsonGrowth = measure(JSON.stringify(item.text)) - 2;
				} else {
					// The overflow walk happens once per run; every later append is dropped by the marker test above.
					({ text, bytes: textBytes } = bound(previous.text + item.text, STREAM_LIMIT));
				}
			}
		} else ({ text, bytes: textBytes } = bound(item.text, STREAM_LIMIT));
		const next = { ...previous, ...item, text, sequence };
		const cost: Cost =
			prior && jsonGrowth !== undefined
				? { text: textBytes, json: prior.json + jsonGrowth }
				: { text: textBytes, json: measure(JSON.stringify(next)) + 1 };
		costs.set(next, cost);
		let timeline = previous ? state.timeline.map((row) => (row.id === item.id ? next : row)) : [...state.timeline, next];
		let truncated = state.timelineTruncated;
		// Bound retained projection by both entries and bytes, while keeping the newest evidence visible.
		let bytes = timelineBytes(state.timeline) - (prior?.json ?? 0) + cost.json;
		let dropped = 0;
		for (const removed of timeline) {
			const retained = timeline.length - dropped;
			if (retained <= 1 || (retained <= MAX_TIMELINE_ITEMS && bytes <= MAX_TIMELINE_BYTES)) break;
			bytes -= itemCost(removed).json;
			dropped++;
			truncated = true;
		}
		if (dropped) timeline = timeline.slice(dropped);
		totals.set(timeline, bytes);
		state = { ...state, timeline, timelineTruncated: truncated || text.endsWith(MARKER) };
	};
	switch (event.type) {
		case "session.labelled":
			return { ...state, label: event.payload.label };
		case "fleet.loopBlocked":
		case "fleet.enqueued":
		case "fleet.started":
		case "fleet.progress":
		case "fleet.completed":
		case "fleet.failed":
		case "evidence.ready":
			return { ...state, fleet: [...state.fleet, event.payload.item].slice(-128) };
		case "health.compacted":
		case "health.contextWarning":
		case "health.toolBudget":
		case "health.provider":
			return { ...state, health: [...state.health, event.payload.item].slice(-32) };
		case "session.changed":
			return { ...state, state: event.payload.state, recoveredOrphan: event.payload.recoveredOrphan };
		case "turn.started": {
			const turn = event.payload.turn;
			state = { ...state, turns: [...state.turns, turn].slice(-128) };
			if (turn.prompt)
				upsert({
					id: `${turn.id}:user`,
					turnId: turn.id,
					kind: "user",
					text: turn.prompt,
					status: "completed",
					origin: turn.origin,
				});
			break;
		}
		case "turn.text":
		case "turn.thought":
		case "turn.user": {
			const { turnId, text, origin, provenance } = event.payload,
				kind = event.type === "turn.text" ? "text" : event.type === "turn.thought" ? "thought" : "user";
			const identity = provenanceKey(provenance);
			if (kind === "user" && origin === "replay")
				state = {
					...state,
					turns: state.turns.map((turn) =>
						turn.id === turnId ? { ...turn, prompt: boundedText(turn.prompt + text) } : turn,
					),
				};
			upsert(
				{
					id: kind === "user" ? `${turnId}:user${identity}` : narrativeId(state.timeline, turnId, kind, identity),
					turnId,
					kind,
					text,
					origin,
					status: origin === "replay" || kind === "user" ? "completed" : "in_progress",
					...(provenance ? { provenance } : {}),
				},
				true,
			);
			break;
		}
		case "turn.tool":
			upsert(event.payload.item);
			break;
		case "permission.requested":
		case "permission.escalated":
		case "permission.resolved":
		case "permission.expired": {
			const permission = event.payload.permission;
			state = {
				...state,
				permissions: [...state.permissions.filter((item) => item.id !== permission.id), permission].slice(-32),
			};
			upsert({
				id: permission.id,
				turnId: permission.turnId,
				kind: "notice",
				text: `Permission ${permission.status}: ${permission.title}`,
				status: permission.status,
				origin: "live",
			});
			break;
		}
		case "turn.finished": {
			const { turnId, stopReason, usage, problem, finishedAt } = event.payload;
			const status = stopReason === "cancelled" ? "cancelled" : problem ? "failed" : "succeeded";
			state = {
				...state,
				turns: state.turns.map((turn) =>
					turn.id === turnId ? { ...turn, status, stopReason, usage, problem, finishedAt } : turn,
				),
				timeline: state.timeline.map((item) =>
					item.turnId === turnId && (item.status === "in_progress" || item.status === "pending")
						? { ...item, status: status === "succeeded" ? "completed" : status }
						: item,
				),
			};
			break;
		}
	}
	return state;
}

/** The same revision buffer is used by React and held-snapshot/reconnect tests. */
export class SessionBuffer {
	private snapshotValue: SessionSnapshot | undefined;
	private pending = new Map<number, { event: SessionDelta; bytes: number }>();
	private pendingBytes = 0;
	private overflow = false;
	get value() {
		return this.snapshotValue;
	}
	get hasGap() {
		return this.overflow || this.pending.size > 0;
	}
	event(event: SessionDelta) {
		if (event.payload.revision <= (this.snapshotValue?.revision ?? -1)) return this.snapshotValue;
		if (this.pending.has(event.payload.revision)) return this.drain();
		const bytes = measure(JSON.stringify(event));
		this.pending.set(event.payload.revision, { event, bytes });
		this.pendingBytes += bytes;
		if (this.pending.size > 4096 || this.pendingBytes > 8 * 1024 * 1024) {
			this.pending.clear();
			this.pendingBytes = 0;
			this.overflow = true;
		}
		return this.drain();
	}
	snapshot(value: SessionSnapshot) {
		this.overflow = false;
		if (!this.snapshotValue || value.revision >= this.snapshotValue.revision) this.snapshotValue = value;
		for (const revision of this.pending.keys())
			if (revision <= (this.snapshotValue?.revision ?? -1)) this.remove(revision);
		return this.drain();
	}
	private remove(revision: number) {
		const held = this.pending.get(revision);
		if (held) this.pendingBytes -= held.bytes;
		this.pending.delete(revision);
	}
	private drain() {
		if (!this.snapshotValue) return undefined;
		while (true) {
			const next = this.pending.get(this.snapshotValue.revision + 1);
			if (!next) return this.snapshotValue;
			this.remove(next.event.payload.revision);
			this.snapshotValue = applySessionDelta(this.snapshotValue, next.event);
		}
	}
}
