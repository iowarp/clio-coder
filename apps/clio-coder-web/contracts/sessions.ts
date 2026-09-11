import { type Static, Type } from "typebox";
import { Id, Problem } from "./common.js";

const closed = { additionalProperties: false };
const string = Type.String();
const nullableString = Type.Union([string, Type.Null()]);
export const Workspace = Type.Object(
	{ id: Id, path: Type.String({ maxLength: 4096 }), name: string, openedAt: string },
	closed,
);
export type Workspace = Static<typeof Workspace>;
export const SessionSummary = Type.Object(
	{
		id: Id,
		workspaceId: Id,
		createdAt: string,
		endedAt: nullableString,
		model: nullableString,
		target: nullableString,
		name: Type.Optional(string),
		firstMessagePreview: Type.Optional(string),
		messageCount: Type.Optional(Type.Integer()),
		lastActivityAt: Type.Optional(string),
	},
	closed,
);
export type SessionSummary = Static<typeof SessionSummary>;
export const Usage = Type.Object(
	{
		input: Type.Integer({ minimum: 0 }),
		output: Type.Integer({ minimum: 0 }),
		cacheRead: Type.Integer({ minimum: 0 }),
		cacheWrite: Type.Integer({ minimum: 0 }),
		reasoning: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export type Usage = Static<typeof Usage>;
export const Provenance = Type.Array(
	Type.Object(
		{
			version: Type.Literal(1),
			role: Type.Union([Type.Literal("orchestrator"), Type.Literal("worker")]),
			agentId: string,
			runId: Type.Optional(nullableString),
			node: Type.Optional(nullableString),
		},
		closed,
	),
	{ maxItems: 16 },
);
export const Origin = Type.Union([Type.Literal("live"), Type.Literal("replay")]);
export const TimelineItem = Type.Object(
	{
		id: string,
		turnId: Id,
		sequence: Type.Integer(),
		kind: Type.Union([
			Type.Literal("user"),
			Type.Literal("text"),
			Type.Literal("thought"),
			Type.Literal("tool"),
			Type.Literal("notice"),
		]),
		text: string,
		status: string,
		origin: Origin,
		title: Type.Optional(string),
		toolKind: Type.Optional(string),
		toolCallId: Type.Optional(string),
		locations: Type.Optional(
			Type.Array(Type.Object({ path: string, line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])) }, closed)),
		),
		rawInput: Type.Optional(Type.Record(string, Type.Unknown())),
		rawOutput: Type.Optional(Type.Record(string, Type.Unknown())),
		provenance: Type.Optional(Provenance),
	},
	closed,
);
export type TimelineItem = Static<typeof TimelineItem>;
export const Turn = Type.Object(
	{
		id: Id,
		prompt: string,
		origin: Origin,
		status: Type.Union([
			Type.Literal("running"),
			Type.Literal("succeeded"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
		startedAt: nullableString,
		finishedAt: nullableString,
		stopReason: nullableString,
		usage: Type.Union([Usage, Type.Null()]),
		problem: Type.Union([Problem, Type.Null()]),
	},
	closed,
);
export type Turn = Static<typeof Turn>;
export const SessionState = Type.Union([
	Type.Literal("starting"),
	Type.Literal("open"),
	Type.Literal("unknown"),
	Type.Literal("closed"),
	Type.Literal("failed"),
]);
export const SessionSnapshot = Type.Object(
	{
		id: Id,
		workspaceId: Id,
		state: SessionState,
		revision: Type.Integer({ minimum: 0 }),
		timeline: Type.Array(TimelineItem),
		timelineTruncated: Type.Boolean(),
		turns: Type.Array(Turn),
		recoveredOrphan: Type.Boolean(),
		label: nullableString,
	},
	closed,
);
export type SessionSnapshot = Static<typeof SessionSnapshot>;
const base = { resource: Id, revision: Type.Integer({ minimum: 1 }) };
const textPayload = Type.Object(
	{ ...base, turnId: Id, text: string, origin: Origin, provenance: Type.Optional(Provenance) },
	closed,
);
export const SessionDeltas = {
	"turn.started": Type.Object({ ...base, turn: Turn }, closed),
	"turn.text": textPayload,
	"turn.thought": textPayload,
	"turn.user": textPayload,
	"turn.tool": Type.Object({ ...base, item: TimelineItem }, closed),
	"turn.finished": Type.Object(
		{
			...base,
			turnId: Id,
			stopReason: string,
			usage: Type.Union([Usage, Type.Null()]),
			problem: Type.Union([Problem, Type.Null()]),
			finishedAt: nullableString,
		},
		closed,
	),
	"permission.rejected": Type.Object({ ...base, turnId: Id, reason: Type.Literal("no-ui") }, closed),
	"session.changed": Type.Object({ ...base, state: SessionState, recoveredOrphan: Type.Boolean() }, closed),
};
export type SessionDelta = {
	[K in keyof typeof SessionDeltas]: { type: K; payload: Static<(typeof SessionDeltas)[K]> };
}[keyof typeof SessionDeltas];
export const ACP_EVENT_KINDS = [
	"safety.loopBlocked",
	"dispatch.enqueued",
	"dispatch.started",
	"dispatch.progress",
	"dispatch.completed",
	"dispatch.failed",
	"accountability.evidenceReady",
] as const;
