import type { QueryClient } from "@tanstack/react-query";
import type { Event } from "../../contracts/events.js";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/routes.js";
import { type SessionDelta, SessionDeltas, type SessionSnapshot } from "../../contracts/sessions.js";
import { FrameEventBuffer } from "./frame-buffer.js";
import { resetSessionBuffers, sessionBuffer } from "./sessions.js";

type OperationEntry = { resource: string; revision: number; operation?: Operation };

export function subscribe(token: string, queries: QueryClient, connection: (state: string) => void) {
	const stream = new EventSource(`${routes.events.path}?token=${encodeURIComponent(token)}`);
	let epoch: string | undefined;

	// One commit per session per display frame, however many chunks landed in it.
	const buffer = new FrameEventBuffer((events) => {
		const snapshots = new Map<string, SessionSnapshot>(),
			gaps = new Set<string>(),
			invalidate = new Set<string>(),
			operations: OperationEntry[] = [];
		let resynced = false;
		for (const event of events) {
			if ((epoch && epoch !== event.epoch) || event.type === "resync") {
				// Everything collected so far is stale, and so is the rest of the batch.
				resynced = true;
				snapshots.clear();
				gaps.clear();
				invalidate.clear();
				operations.length = 0;
				epoch = event.epoch;
				continue;
			}
			epoch = event.epoch;
			if (Object.hasOwn(SessionDeltas, event.type)) {
				const delta = event as SessionDelta,
					held = sessionBuffer(delta.payload.resource),
					state = held.event(delta);
				if (state) snapshots.set(state.id, state);
				if (held.hasGap) gaps.add(delta.payload.resource);
				if (delta.type === "session.changed" || delta.type === "session.labelled") {
					invalidate.add("sessions");
					invalidate.add("session-history");
				}
			}
			if (event.type === "hello") connection("Connected");
			if (event.type === "operation.finished") {
				operations.push({ ...event.payload });
				invalidate.add("tools");
				if (event.payload.kind.startsWith("evidence."))
					for (const key of ["evidence", "evidence-detail", "fleet-receipt"]) invalidate.add(key);
				if (event.payload.kind.startsWith("targets."))
					for (const key of ["targets", "routing", "workspace-settings", "config-graph"]) invalidate.add(key);
			}
			if (event.type === "operation.progress") operations.push({ ...event.payload });
			if (event.type === "toolchain.changed") invalidate.add("tools");
		}
		if (resynced) {
			queries.removeQueries({ queryKey: ["operation"] });
			resetSessionBuffers();
			void queries.resetQueries({ queryKey: ["session"] });
			void queries.invalidateQueries();
			return;
		}
		for (const [id, state] of snapshots) queries.setQueryData<SessionSnapshot>(["session", id], state);
		for (const id of gaps) void queries.invalidateQueries({ queryKey: ["session", id] });
		for (const entry of operations) {
			if (entry.operation)
				queries.setQueryData<Operation>(["operation", entry.resource], (current) =>
					current && current.revision > entry.revision ? current : entry.operation,
				);
			else void queries.invalidateQueries({ queryKey: ["operation", entry.resource] });
		}
		for (const key of invalidate) void queries.invalidateQueries({ queryKey: [key] });
	});

	const receive = (message: MessageEvent<string>) => buffer.push(JSON.parse(message.data) as Event);
	for (const type of [
		"hello",
		"resync",
		"operation.progress",
		"operation.finished",
		"toolchain.changed",
		...Object.keys(SessionDeltas),
	])
		stream.addEventListener(type, receive as EventListener);
	stream.onerror = () => {
		// The last painted state must match the last state actually received.
		buffer.flush();
		connection("Reconnecting…");
	};
	const onVisibility = () => {
		if (document.visibilityState === "visible") buffer.flush();
	};
	document.addEventListener("visibilitychange", onVisibility);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		// Closing the buffer first stops a scheduled frame landing in a torn-down tree.
		buffer.close();
		stream.close();
	};
}
