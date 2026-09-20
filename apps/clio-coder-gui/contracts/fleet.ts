import { type Static, Type } from "typebox";
import { Id, PageCursor } from "./common.js";

const closed = { additionalProperties: false };
const text = Type.String();
const nullable = Type.Union([text, Type.Null()]);
const count = Type.Integer({ minimum: 0 });
export const FleetPageQuery = Type.Object(
	{ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(PageCursor) },
	closed,
);
export const FleetRoot = Type.Object(
	{
		id: Id,
		fleet: text,
		planHash: text,
		startedAt: text,
		endedAt: nullable,
		resumedFrom: nullable,
		stepCount: count,
		completedCount: count,
	},
	closed,
);
export const FleetRoots = Type.Object(
	{ items: Type.Array(FleetRoot), nextCursor: Type.Union([PageCursor, Type.Null()]) },
	closed,
);
export const DispatchRun = Type.Object(
	{
		id: Id,
		agentId: text,
		executionRole: text,
		task: text,
		targetId: text,
		wireModelId: text,
		runtimeId: text,
		startedAt: text,
		endedAt: nullable,
		status: text,
		outcome: nullable,
		outcomeDetail: nullable,
		cwd: text,
		sessionId: nullable,
		tokenCount: Type.Number(),
		costUsd: Type.Number(),
		parentRunId: nullable,
		rootRunId: nullable,
	},
	closed,
);
export const DispatchRuns = Type.Object(
	{ items: Type.Array(DispatchRun), nextCursor: Type.Union([PageCursor, Type.Null()]) },
	closed,
);
export const FleetReceipt = Type.Object(
	{ receipt: Type.Union([Type.Record(text, Type.Unknown()), Type.Null()]) },
	closed,
);
const memberTurn = Type.Object(
	{ round: count, runId: text, status: text, outcome: nullable, terminal: Type.Boolean() },
	closed,
);
const member = Type.Object(
	{
		label: text,
		agentId: text,
		targetId: text,
		wireModelId: text,
		executionRole: text,
		turns: Type.Array(memberTurn),
		turnsTruncated: Type.Boolean(),
	},
	closed,
);
const judge = Type.Object(
	{ runId: text, agentId: text, targetId: text, wireModelId: text, status: text, outcome: nullable },
	closed,
);
export const Council = Type.Object(
	{
		group: text,
		startedAt: text,
		endedAt: nullable,
		running: Type.Boolean(),
		roundsPlanned: Type.Union([count, Type.Null()]),
		roundsObserved: count,
		origin: nullable,
		approval: nullable,
		members: Type.Array(member),
		membersTruncated: Type.Boolean(),
		membersRejected: count,
		synthesis: Type.Object({ kind: nullable, sealedRunId: nullable, judge: Type.Union([judge, Type.Null()]) }, closed),
	},
	closed,
);
export const Councils = Type.Object({ councils: Type.Array(Council), truncated: Type.Boolean() }, closed);
const correlation = Type.Object(
	{
		agent: Type.Boolean(),
		target: Type.Boolean(),
		modelFamily: Type.Boolean(),
		runtime: Type.Boolean(),
		node: Type.Boolean(),
		independent: Type.Boolean(),
	},
	closed,
);
export const FleetGate = Type.Object(
	{
		id: text,
		group: text,
		topology: text,
		cycle: count,
		outcome: text,
		decidedAt: text,
		subjects: Type.Array(text),
		subjectsTruncated: Type.Boolean(),
		decider: nullable,
		correlation: Type.Union([correlation, Type.Null()]),
		winner: Type.Union([Type.Object({ index: count, runId: text }, closed), Type.Null()]),
		confirms: nullable,
		reason: nullable,
	},
	closed,
);
export const FleetGates = Type.Object(
	{ present: Type.Boolean(), decisions: Type.Array(FleetGate), truncated: Type.Boolean(), unverifiable: count },
	closed,
);
export const FleetRootDetail = Type.Object(
	{
		run: FleetRoot,
		steps: Type.Array(
			Type.Object(
				{
					stepId: text,
					terminalRunId: nullable,
					assignmentId: nullable,
					succeeded: Type.Boolean(),
					integrityValid: Type.Boolean(),
					failureReason: nullable,
					output: text,
				},
				closed,
			),
		),
		receipt: FleetReceipt.properties.receipt,
		councils: Councils,
		gates: FleetGates,
	},
	closed,
);
export type FleetRoot = Static<typeof FleetRoot>;
export type DispatchRun = Static<typeof DispatchRun>;
export type FleetRequest =
	| { kind: "roots" | "dispatches"; limit: number; cursor?: string }
	| { kind: "root" | "dispatch" | "receipt"; id: string }
	| { kind: "councils" | "gates" };
