import type { SessionDelta, SessionSnapshot, TimelineItem } from "./sessions.js";

const encoder = new TextEncoder();
const MARKER = "\n[… stream truncated …]";
export function boundedText(value: string, limit = 65536) {
	if (encoder.encode(value).byteLength <= limit) return value;
	const budget = limit - encoder.encode(MARKER).byteLength;
	let used = 0,
		output = "";
	for (const character of value) {
		const bytes = encoder.encode(character).byteLength;
		if (used + bytes > budget) break;
		output += character;
		used += bytes;
	}
	return output + MARKER;
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
	};
}
export function applySessionDelta(current: SessionSnapshot, event: SessionDelta): SessionSnapshot {
	if (event.payload.resource !== current.id || event.payload.revision <= current.revision) return current;
	if (event.payload.revision !== current.revision + 1) throw new Error("Session revision gap requires a snapshot.");
	let state: SessionSnapshot = { ...current, revision: event.payload.revision };
	const upsert = (item: Omit<TimelineItem, "sequence">, append = false) => {
		const previous = state.timeline.find((row) => row.id === item.id);
		const sequence = previous?.sequence ?? (state.timeline.at(-1)?.sequence ?? 0) + 1;
		const text =
			append && previous
				? previous.text.endsWith(MARKER)
					? previous.text
					: boundedText(previous.text + item.text)
				: boundedText(item.text);
		const next = { ...previous, ...item, text, sequence };
		let timeline = previous ? state.timeline.map((row) => (row.id === item.id ? next : row)) : [...state.timeline, next];
		let truncated = state.timelineTruncated;
		// Bound retained projection by both entries and bytes, while keeping the newest evidence visible.
		let bytes = encoder.encode(JSON.stringify(timeline)).byteLength;
		while ((timeline.length > 2048 || bytes > 2 * 1024 * 1024) && timeline.length > 1) {
			const removed = timeline[0];
			timeline = timeline.slice(1);
			bytes -= encoder.encode(JSON.stringify(removed)).byteLength + 1;
			truncated = true;
		}
		state = { ...state, timeline, timelineTruncated: truncated || text.endsWith(MARKER) };
	};
	switch (event.type) {
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
			const identity = provenance
				? `:${provenance.map((agent) => `${agent.agentId}:${agent.runId ?? ""}`).join("|")}`
				: "";
			if (kind === "user" && origin === "replay")
				state = {
					...state,
					turns: state.turns.map((turn) =>
						turn.id === turnId ? { ...turn, prompt: boundedText(turn.prompt + text) } : turn,
					),
				};
			upsert(
				{
					id: `${turnId}:${kind}${identity}`,
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
		case "permission.rejected":
			upsert({
				id: `${event.payload.turnId}:permission:${event.payload.revision}`,
				turnId: event.payload.turnId,
				kind: "notice",
				text: "Permission rejected: approval UI is not available in this slice.",
				status: "rejected",
				origin: "live",
			});
			break;
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
	private pending = new Map<number, SessionDelta>();
	private overflow = false;
	get value() {
		return this.snapshotValue;
	}
	get hasGap() {
		return this.overflow || this.pending.size > 0;
	}
	event(event: SessionDelta) {
		if (event.payload.revision <= (this.snapshotValue?.revision ?? -1)) return this.snapshotValue;
		this.pending.set(event.payload.revision, event);
		if (this.pending.size > 4096) {
			this.pending.clear();
			this.overflow = true;
		}
		return this.drain();
	}
	snapshot(value: SessionSnapshot) {
		this.overflow = false;
		if (!this.snapshotValue || value.revision >= this.snapshotValue.revision) this.snapshotValue = value;
		for (const revision of this.pending.keys())
			if (revision <= (this.snapshotValue?.revision ?? -1)) this.pending.delete(revision);
		return this.drain();
	}
	private drain() {
		if (!this.snapshotValue) return undefined;
		while (true) {
			const next = this.pending.get(this.snapshotValue.revision + 1);
			if (!next) return this.snapshotValue;
			this.pending.delete(next.payload.revision);
			this.snapshotValue = applySessionDelta(this.snapshotValue, next);
		}
	}
}
