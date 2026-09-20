import type { QueryClient } from "@tanstack/react-query";
import type { Event } from "../../contracts/events.js";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/routes.js";
import { type SessionDelta, SessionDeltas, type SessionSnapshot } from "../../contracts/sessions.js";
import { resetSessionBuffers, sessionBuffer } from "./sessions.js";

export function subscribe(token: string, queries: QueryClient, connection: (state: string) => void) {
	const stream = new EventSource(`${routes.events.path}?token=${encodeURIComponent(token)}`);
	let epoch: string | undefined;
	const receive = (message: MessageEvent<string>) => {
		const event = JSON.parse(message.data) as Event;
		if ((epoch && epoch !== event.epoch) || event.type === "resync") {
			queries.removeQueries({ queryKey: ["operation"] });
			resetSessionBuffers();
			void queries.resetQueries({ queryKey: ["session"] });
			void queries.invalidateQueries();
		}
		epoch = event.epoch;
		if (Object.hasOwn(SessionDeltas, event.type)) {
			const delta = event as SessionDelta,
				buffer = sessionBuffer(delta.payload.resource),
				state = buffer.event(delta);
			if (state) queries.setQueryData<SessionSnapshot>(["session", state.id], state);
			if (buffer.hasGap) void queries.invalidateQueries({ queryKey: ["session", delta.payload.resource] });
			if (delta.type === "session.changed" || delta.type === "session.labelled") {
				void queries.invalidateQueries({ queryKey: ["sessions"] });
				void queries.invalidateQueries({ queryKey: ["session-history"] });
			}
		}
		if (event.type === "hello") connection("Connected");
		if (event.type === "operation.finished") {
			if (event.payload.operation)
				queries.setQueryData<Operation>(["operation", event.payload.resource], (current) =>
					current && current.revision > event.payload.revision ? current : event.payload.operation,
				);
			else void queries.invalidateQueries({ queryKey: ["operation", event.payload.resource] });
			void queries.invalidateQueries({ queryKey: ["tools"] });
			if (event.payload.kind.startsWith("evidence.")) {
				for (const key of ["evidence", "evidence-detail", "fleet-receipt"])
					void queries.invalidateQueries({ queryKey: [key] });
			}
			if (event.payload.kind.startsWith("targets.")) {
				for (const key of ["targets", "routing", "workspace-settings", "config-graph"])
					void queries.invalidateQueries({ queryKey: [key] });
			}
		}
		if (event.type === "operation.progress")
			void queries.invalidateQueries({ queryKey: ["operation", event.payload.resource] });
		if (event.type === "toolchain.changed") void queries.invalidateQueries({ queryKey: ["tools"] });
	};
	for (const type of [
		"hello",
		"resync",
		"operation.progress",
		"operation.finished",
		"toolchain.changed",
		...Object.keys(SessionDeltas),
	])
		stream.addEventListener(type, receive as EventListener);
	stream.onerror = () => connection("Reconnecting…");
	return () => stream.close();
}
