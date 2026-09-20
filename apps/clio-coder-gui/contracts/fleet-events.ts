import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const identifier = Type.String({ maxLength: 128 });
const nullableId = Type.Union([identifier, Type.Null()]);
const count = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const identity = { runId: identifier, agentId: identifier };
const start = Type.Object(
	{
		...identity,
		taskPreview: Type.Union([Type.String({ maxLength: 160 }), Type.Null()]),
		node: nullableId,
		origin: nullableId,
		attempt: count,
	},
	closed,
);
export const FleetPayloads = {
	"fleet.loopBlocked": Type.Object(
		{
			toolCallId: Type.Null(),
			tool: Type.String({ maxLength: 64 }),
			repeatCount: count,
			blocksThisTurn: count,
			budget: count,
			disposition: Type.Union([Type.Literal("block"), Type.Literal("lockout"), Type.Literal("stop")]),
			interrupted: Type.Boolean(),
			shape: Type.Null(),
		},
		closed,
	),
	"fleet.enqueued": start,
	"fleet.started": start,
	"fleet.progress": Type.Object({ ...identity, progressCount: count, truncated: Type.Boolean() }, closed),
	"fleet.completed": Type.Object(
		{ ...identity, outcome: nullableId, outcomeCode: nullableId, durationMs: count, tokenCount: count },
		closed,
	),
	"fleet.failed": Type.Object({ ...identity, outcome: nullableId, reason: nullableId, durationMs: count }, closed),
	"evidence.ready": Type.Object(
		{
			runId: identifier,
			evidenceId: identifier,
			firstPassSuccess: Type.Boolean(),
			findingCount: count,
			tags: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
		},
		closed,
	),
};
export const FleetFacts = {
	"fleet.loopBlocked": Type.Object(
		{ type: Type.Literal("fleet.loopBlocked"), payload: FleetPayloads["fleet.loopBlocked"] },
		closed,
	),
	"fleet.enqueued": Type.Object(
		{ type: Type.Literal("fleet.enqueued"), payload: FleetPayloads["fleet.enqueued"] },
		closed,
	),
	"fleet.started": Type.Object({ type: Type.Literal("fleet.started"), payload: FleetPayloads["fleet.started"] }, closed),
	"fleet.progress": Type.Object(
		{ type: Type.Literal("fleet.progress"), payload: FleetPayloads["fleet.progress"] },
		closed,
	),
	"fleet.completed": Type.Object(
		{ type: Type.Literal("fleet.completed"), payload: FleetPayloads["fleet.completed"] },
		closed,
	),
	"fleet.failed": Type.Object({ type: Type.Literal("fleet.failed"), payload: FleetPayloads["fleet.failed"] }, closed),
	"evidence.ready": Type.Object(
		{ type: Type.Literal("evidence.ready"), payload: FleetPayloads["evidence.ready"] },
		closed,
	),
};
export const FleetFact = Type.Union([
	FleetFacts["fleet.loopBlocked"],
	FleetFacts["fleet.enqueued"],
	FleetFacts["fleet.started"],
	FleetFacts["fleet.progress"],
	FleetFacts["fleet.completed"],
	FleetFacts["fleet.failed"],
	FleetFacts["evidence.ready"],
]);
export const FleetItem = Type.Object(
	{
		id: Id,
		at: Type.String(),
		sourceSequence: Type.Integer({ minimum: 1 }),
		fact: FleetFact,
	},
	closed,
);
export type FleetItem = Static<typeof FleetItem>;
export const ACP_TO_WEB_EVENT = {
	"safety.loopBlocked": "fleet.loopBlocked",
	"dispatch.enqueued": "fleet.enqueued",
	"dispatch.started": "fleet.started",
	"dispatch.progress": "fleet.progress",
	"dispatch.completed": "fleet.completed",
	"dispatch.failed": "fleet.failed",
	"accountability.evidenceReady": "evidence.ready",
} as const;
