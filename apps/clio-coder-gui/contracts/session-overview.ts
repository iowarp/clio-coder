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
const runId = Type.String({ maxLength: 128 });
export const SessionWorkerRun = Type.Object(
	{
		runId,
		agentId: Type.Union([runId, Type.Null()]),
		state: Type.Union([Type.Literal("active"), Type.Literal("queued")]),
		node: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
	},
	closed,
);
export type SessionWorkerRun = Static<typeof SessionWorkerRun>;
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
		/** The runs the server holds live, active first; outlives the snapshot's bounded fleet feed. */
		runs: Type.Array(SessionWorkerRun, { maxItems: 64 }),
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
