import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { Operation, Progress } from "./operations.js";
import { SessionDeltas } from "./sessions.js";

const base = { v: Type.Literal(1), epoch: Id, seq: Type.Integer({ minimum: 0 }), at: Type.String() };
const cursor = { epoch: Id, seq: Type.Integer({ minimum: 0 }) };
const resource = { resource: Id, revision: Type.Integer({ minimum: 1 }) };
export const Event = Type.Union([
	Type.Object({ ...base, type: Type.Literal("turn.started"), payload: SessionDeltas["turn.started"] }),
	Type.Object({ ...base, type: Type.Literal("turn.text"), payload: SessionDeltas["turn.text"] }),
	Type.Object({ ...base, type: Type.Literal("turn.thought"), payload: SessionDeltas["turn.thought"] }),
	Type.Object({ ...base, type: Type.Literal("turn.user"), payload: SessionDeltas["turn.user"] }),
	Type.Object({ ...base, type: Type.Literal("turn.tool"), payload: SessionDeltas["turn.tool"] }),
	Type.Object({ ...base, type: Type.Literal("turn.finished"), payload: SessionDeltas["turn.finished"] }),
	Type.Object({ ...base, type: Type.Literal("permission.requested"), payload: SessionDeltas["permission.requested"] }),
	Type.Object({ ...base, type: Type.Literal("permission.escalated"), payload: SessionDeltas["permission.escalated"] }),
	Type.Object({ ...base, type: Type.Literal("permission.resolved"), payload: SessionDeltas["permission.resolved"] }),
	Type.Object({ ...base, type: Type.Literal("permission.expired"), payload: SessionDeltas["permission.expired"] }),
	Type.Object({ ...base, type: Type.Literal("session.labelled"), payload: SessionDeltas["session.labelled"] }),
	Type.Object({ ...base, type: Type.Literal("fleet.loopBlocked"), payload: SessionDeltas["fleet.loopBlocked"] }),
	Type.Object({ ...base, type: Type.Literal("fleet.enqueued"), payload: SessionDeltas["fleet.enqueued"] }),
	Type.Object({ ...base, type: Type.Literal("fleet.started"), payload: SessionDeltas["fleet.started"] }),
	Type.Object({ ...base, type: Type.Literal("fleet.progress"), payload: SessionDeltas["fleet.progress"] }),
	Type.Object({ ...base, type: Type.Literal("fleet.completed"), payload: SessionDeltas["fleet.completed"] }),
	Type.Object({ ...base, type: Type.Literal("fleet.failed"), payload: SessionDeltas["fleet.failed"] }),
	Type.Object({ ...base, type: Type.Literal("evidence.ready"), payload: SessionDeltas["evidence.ready"] }),
	Type.Object({ ...base, type: Type.Literal("session.changed"), payload: SessionDeltas["session.changed"] }),

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
