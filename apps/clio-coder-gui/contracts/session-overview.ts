import type { Static } from "typebox";
import { Type } from "typebox";
import { Id } from "./common.js";
import { SessionState } from "./sessions.js";

const closed = { additionalProperties: false };
const nullableText = Type.Union([Type.String({ maxLength: 512 }), Type.Null()]);
export const SessionActivity = Type.Union([
	Type.Literal("approval"),
	Type.Literal("question"),
	Type.Literal("working"),
	Type.Literal("queued"),
	Type.Literal("ready"),
	Type.Literal("parked"),
	Type.Literal("closed"),
	Type.Literal("failed"),
	Type.Literal("unknown"),
	Type.Literal("starting"),
]);
export const SessionOverviewItem = Type.Object(
	{
		id: Id,
		workspaceId: Id,
		revision: Type.Integer({ minimum: 0 }),
		state: SessionState,
		activity: SessionActivity,
		title: Type.String({ maxLength: 512 }),
		model: nullableText,
		target: nullableText,
		updatedAt: nullableText,
		turnCount: Type.Integer({ minimum: 0 }),
		currentTurnId: Type.Union([Id, Type.Null()]),
		pendingApprovals: Type.Integer({ minimum: 0 }),
		pendingQuestions: Type.Integer({ minimum: 0 }),
		activeWorkers: Type.Integer({ minimum: 0 }),
		queuedWorkers: Type.Integer({ minimum: 0 }),
		workersComplete: Type.Boolean(),
		activeJobs: Type.Integer({ minimum: 0 }),
		nodes: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 128 }),
		recoveredOrphan: Type.Boolean(),
		untouched: Type.Boolean(),
	},
	closed,
);
export type SessionOverviewItem = Static<typeof SessionOverviewItem>;
export const SessionOverview = Type.Object(
	{
		host: Type.String({ maxLength: 256 }),
		sessions: Type.Array(SessionOverviewItem),
	},
	closed,
);
export type SessionOverview = Static<typeof SessionOverview>;
