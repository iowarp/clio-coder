import type { QueryClient } from "@tanstack/react-query";
import type { Event } from "../../contracts/events.js";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/routes.js";
import { type SessionDelta, SessionDeltas, type SessionSnapshot } from "../../contracts/sessions.js";
import { onTokenRejected, tokenRejected } from "./auth-state.js";
import { type Client, emptyInput } from "./client.js";
import { FrameEventBuffer } from "./frame-buffer.js";
import { resetSessionBuffers, sessionBuffer } from "./sessions.js";

type OperationEntry = { resource: string; revision: number; operation?: Operation };
export type ConnectionState = "Connecting…" | "Connected" | "Reconnecting…" | "Not connected";

export function subscribe(client: Client, queries: QueryClient, connection: (state: ConnectionState) => void) {
	let stream: EventSource | null = null;
	let cursor: string | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryMs = 1_000;
	let disposed = false;
	let epoch: string | undefined;
	let disconnected = false;

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
				if (
					delta.type === "session.changed" ||
					delta.type === "session.labelled" ||
					delta.type === "turn.started" ||
					delta.type === "turn.finished" ||
					delta.type === "permission.requested" ||
					delta.type === "permission.resolved" ||
					delta.type === "permission.expired"
				) {
					invalidate.add("sessions");
				}
				if (delta.type === "session.changed" || delta.type === "session.labelled" || delta.type === "turn.finished") {
					invalidate.add("session-history");
				}
			}
			if (event.type === "hello") {
				if (disconnected) {
					if (!resynced) {
						// A failed REST refresh can leave a conversation showing an error even
						// after the event stream catches up. Heal the visible read on reconnect.
						void queries.invalidateQueries({ queryKey: ["session"] });
						void queries.invalidateQueries({ queryKey: ["sessions"] });
					}
					disconnected = false;
				}
				connection("Connected");
			}
			if (event.type === "operation.finished") {
				operations.push({ ...event.payload });
				invalidate.add("tools");
				if (event.payload.kind.startsWith("evidence."))
					for (const key of ["evidence", "evidence-detail", "fleet-receipt"]) invalidate.add(key);
				if (event.payload.kind.startsWith("targets."))
					for (const key of [
						"targets",
						"routing",
						"workspace-settings",
						"config-graph",
						"target-runtimes",
						"settings-controls",
					])
						invalidate.add(key);
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

	const connect = () => {
		if (disposed || tokenRejected()) return;
		const query = new URLSearchParams({ token: client.token });
		if (cursor !== undefined) query.set("after", cursor);
		const source = new EventSource(`${routes.events.path}?${query}`);
		stream = source;
		const receive = (message: MessageEvent<string>) => {
			if (disposed || stream !== source) return;
			const event = JSON.parse(message.data) as Event;
			cursor = `${event.epoch}:${event.seq}`;
			if (event.type === "hello") retryMs = 1_000;
			buffer.push(event);
		};
		for (const type of [
			"hello",
			"resync",
			"operation.progress",
			"operation.finished",
			"toolchain.changed",
			...Object.keys(SessionDeltas),
		])
			source.addEventListener(type, receive as EventListener);
		source.onerror = () => {
			if (disposed || stream !== source) return;
			disconnected = true;
			// Paint every received event before reporting a connection loss.
			buffer.flush();
			if (tokenRejected()) {
				source.close();
				stream = null;
				connection("Not connected");
				return;
			}
			connection("Reconnecting…");
			// EventSource retries while CONNECTING, but a CLOSED source never retries.
			if (source.readyState !== EventSource.CLOSED) return;
			source.close();
			stream = null;
			// The stream hides its HTTP status. A normal authenticated read distinguishes a refused
			// launch token from a recoverable SSE failure through the client's existing 401 handling.
			void client.call(routes.meta, emptyInput).catch(() => {});
			retryTimer = setTimeout(() => {
				retryTimer = null;
				connect();
			}, retryMs);
			retryMs = Math.min(retryMs * 2, 30_000);
		};
	};
	connect();
	// The refusal can also be learned after the last stream error, from an ordinary request.
	const stopWatching = onTokenRejected(() => {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
		stream?.close();
		stream = null;
		connection("Not connected");
	});
	const onVisibility = () => {
		if (document.visibilityState === "visible") buffer.flush();
	};
	document.addEventListener("visibilitychange", onVisibility);
	return () => {
		disposed = true;
		document.removeEventListener("visibilitychange", onVisibility);
		stopWatching();
		if (retryTimer !== null) clearTimeout(retryTimer);
		// Closing the buffer first stops a scheduled frame landing in a torn-down tree.
		buffer.close();
		stream?.close();
	};
}
