import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { Operation, Progress } from "./operations.js";

const base = { v: Type.Literal(1), epoch: Id, seq: Type.Integer({ minimum: 0 }), at: Type.String() };
const cursor = { epoch: Id, seq: Type.Integer({ minimum: 0 }) };
const resource = { resource: Id, revision: Type.Integer({ minimum: 1 }) };
export const Event = Type.Union([
	Type.Object({ ...base, type: Type.Literal("hello"), payload: Type.Object(cursor) }),
	Type.Object({
		...base,
		type: Type.Literal("resync"),
		payload: Type.Object({ ...cursor, reason: Type.Union([Type.Literal("epoch"), Type.Literal("evicted")]) }),
	}),
	Type.Object({
		...base,
		type: Type.Literal("operation.progress"),
		payload: Type.Object({ ...resource, progress: Progress }),
	}),
	Type.Object({
		...base,
		type: Type.Literal("operation.finished"),
		payload: Type.Object({ ...resource, operation: Operation }),
	}),
	Type.Object({ ...base, type: Type.Literal("toolchain.changed"), payload: Type.Object({ id: Id }) }),
]);
export type Event = Static<typeof Event>;
export type DomainEvent = Exclude<Event, { type: "hello" | "resync" }>;
export type EventInput = {
	[K in DomainEvent["type"]]: Pick<Extract<DomainEvent, { type: K }>, "type" | "payload">;
}[DomainEvent["type"]];
export const EventCursor = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[0-9]{1,16}$", maxLength: 145 });
