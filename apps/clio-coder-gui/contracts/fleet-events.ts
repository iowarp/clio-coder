import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { ReceiptFacts } from "./receipt-facts.js";

const closed = { additionalProperties: false };
const identifier = Type.String({ maxLength: 128 });
const nullableId = Type.Union([identifier, Type.Null()]);
const count = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const identity = { runId: identifier, agentId: identifier };
const outcomeDetail = Type.Optional(Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]));
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
		{ ...identity, outcome: nullableId, outcomeCode: nullableId, outcomeDetail, durationMs: count, tokenCount: count },
		closed,
	),
	"fleet.failed": Type.Object(
		{
			...identity,
			outcome: nullableId,
			reason: nullableId,
			outcomeCode: Type.Optional(nullableId),
			outcomeDetail,
			durationMs: count,
		},
		closed,
	),
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
		receipt: Type.Optional(ReceiptFacts),
	},
	closed,
);
export type FleetItem = Static<typeof FleetItem>;
/**
 * The session's own health, as opposed to the fleet's. These five say the
 * context window was cut, that it is close to full, that the loop guard stopped
 * a turn on call volume, that a target changed state, and that a dispatch's scope
 * entry did something its request did not say. They are kept out of
 * `fleet` because they describe this conversation rather than a dispatched run,
 * and a board that mixed them would have to filter its own feed to draw either.
 */
export const HealthPayloads = {
	"health.compacted": Type.Object(
		{
			trigger: Type.String({ maxLength: 64 }),
			outcome: Type.Optional(
				Type.Union([
					Type.Literal("completed"),
					Type.Literal("unchanged"),
					Type.Literal("failed"),
					Type.Literal("cancelled"),
				]),
			),
		},
		closed,
	),
	"health.contextWarning": Type.Object({ warning: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]) }, closed),
	"health.toolBudget": Type.Object(
		{
			tool: Type.String({ maxLength: 64 }),
			callsThisTurn: count,
			softBudget: count,
			hardCeiling: count,
			interrupted: Type.Boolean(),
		},
		closed,
	),
	"health.scopeNotice": Type.Object(
		{ code: Type.String({ maxLength: 64 }), message: Type.String({ maxLength: 1024 }) },
		closed,
	),
	"health.provider": Type.Object(
		{
			targetId: identifier,
			status: Type.Union([
				Type.Literal("healthy"),
				Type.Literal("degraded"),
				Type.Literal("unknown"),
				Type.Literal("down"),
			]),
			available: Type.Boolean(),
			latencyMs: count,
		},
		closed,
	),
};
export const HealthFacts = {
	"health.compacted": Type.Object(
		{ type: Type.Literal("health.compacted"), payload: HealthPayloads["health.compacted"] },
		closed,
	),
	"health.contextWarning": Type.Object(
		{ type: Type.Literal("health.contextWarning"), payload: HealthPayloads["health.contextWarning"] },
		closed,
	),
	"health.toolBudget": Type.Object(
		{ type: Type.Literal("health.toolBudget"), payload: HealthPayloads["health.toolBudget"] },
		closed,
	),
	"health.provider": Type.Object(
		{ type: Type.Literal("health.provider"), payload: HealthPayloads["health.provider"] },
		closed,
	),
	"health.scopeNotice": Type.Object(
		{ type: Type.Literal("health.scopeNotice"), payload: HealthPayloads["health.scopeNotice"] },
		closed,
	),
};
export const HealthFact = Type.Union([
	HealthFacts["health.compacted"],
	HealthFacts["health.contextWarning"],
	HealthFacts["health.toolBudget"],
	HealthFacts["health.provider"],
	HealthFacts["health.scopeNotice"],
]);
export const HealthItem = Type.Object(
	{ id: Id, at: Type.String(), sourceSequence: Type.Integer({ minimum: 1 }), fact: HealthFact },
	closed,
);
export type HealthItem = Static<typeof HealthItem>;
export const HEALTH_EVENT_TYPES = [
	"health.compacted",
	"health.contextWarning",
	"health.toolBudget",
	"health.provider",
	"health.scopeNotice",
] as const;
/**
 * Every `_clio-coder/event` kind this app understands, mapped to the delta it
 * becomes. Adding an engine kind here without also adding it to
 * `ACP_EVENT_KINDS` in `sessions.ts` only means the server never opts in; the
 * reverse leaves an opted-in kind with nowhere to go, which the reader logs and
 * drops rather than treating as a broken peer.
 */
export const ACP_TO_WEB_EVENT = {
	"safety.loopBlocked": "fleet.loopBlocked",
	"dispatch.enqueued": "fleet.enqueued",
	"dispatch.started": "fleet.started",
	"dispatch.progress": "fleet.progress",
	"dispatch.completed": "fleet.completed",
	"dispatch.failed": "fleet.failed",
	"accountability.evidenceReady": "evidence.ready",
	"compaction.end": "health.compacted",
	"context.warning": "health.contextWarning",
	"safety.toolBudgetExceeded": "health.toolBudget",
	"provider.health": "health.provider",
	"dispatch.scopeNotice": "health.scopeNotice",
} as const;
