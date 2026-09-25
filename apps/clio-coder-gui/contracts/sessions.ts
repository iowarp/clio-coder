import { type Static, Type } from "typebox";
import { Id, Problem } from "./common.js";
import { FleetItem, HealthItem } from "./fleet-events.js";
import { Permission } from "./permissions.js";

const closed = { additionalProperties: false };
const string = Type.String();
const nullableString = Type.Union([string, Type.Null()]);
export const Workspace = Type.Object(
	{ id: Id, path: Type.String({ maxLength: 4096 }), name: string, openedAt: string },
	closed,
);
export type Workspace = Static<typeof Workspace>;
/** A bounded, directory-only view of the local machine for choosing a project. */
export const WorkspaceFolders = Type.Object(
	{
		path: Type.String({ maxLength: 4096 }),
		parent: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
		homePath: Type.String({ maxLength: 4096 }),
		launchPath: Type.String({ maxLength: 4096 }),
		directories: Type.Array(
			Type.Object(
				{ name: Type.String({ maxLength: 512 }), path: Type.String({ maxLength: 4096 }) },
				{ additionalProperties: false },
			),
			{ maxItems: 200 },
		),
		truncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type WorkspaceFolders = Static<typeof WorkspaceFolders>;
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
		// Clio reports its own cost; the contract has to admit it or Value.Clean drops it before a turn records it.
		costUsd: Type.Optional(Type.Number({ minimum: 0 })),
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
		/**
		 * The running tool's newest CUMULATIVE output snapshot, present only while
		 * the call is open and dropped the moment its terminal frame lands.
		 *
		 * It is deliberately not folded into `rawOutput`. `rawOutput` is the tool's
		 * final structured result and is what the raw inspector renders; a progress
		 * snapshot is neither final nor structured, and writing it there would make
		 * a running call indistinguishable from a finished one and force the
		 * inspector to re-walk a content array several times a second. A flat,
		 * bounded string is replaced in O(1), which is the shape a live pane wants.
		 */
		partialOutput: Type.Optional(Type.String({ maxLength: 32768 })),
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
		permissions: Type.Array(Permission, { maxItems: 32 }),
		fleet: Type.Array(FleetItem, { maxItems: 128 }),
		// Session health, bounded far tighter than the fleet feed: a context
		// meter and a footer status read the newest of each kind, not a history.
		health: Type.Array(HealthItem, { maxItems: 32 }),
	},
	closed,
);
export type SessionSnapshot = Static<typeof SessionSnapshot>;
const base = { resource: Id, revision: Type.Integer({ minimum: 1 }) };
const textPayload = Type.Object(
	{ ...base, turnId: Id, text: string, origin: Origin, provenance: Type.Optional(Provenance) },
	closed,
);
const permissionPayload = Type.Object({ ...base, permission: Permission }, closed);
const fleetPayload = Type.Object({ ...base, item: FleetItem }, closed);
const healthPayload = Type.Object({ ...base, item: HealthItem }, closed);
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
	"permission.requested": permissionPayload,
	"permission.escalated": permissionPayload,
	"permission.resolved": permissionPayload,
	"permission.expired": permissionPayload,
	"fleet.loopBlocked": fleetPayload,
	"fleet.enqueued": fleetPayload,
	"fleet.started": fleetPayload,
	"fleet.progress": fleetPayload,
	"fleet.completed": fleetPayload,
	"fleet.failed": fleetPayload,
	"evidence.ready": fleetPayload,
	"health.compacted": healthPayload,
	"health.contextWarning": healthPayload,
	"health.toolBudget": healthPayload,
	"health.provider": healthPayload,
	"session.labelled": Type.Object({ ...base, label: nullableString }, closed),
	"session.changed": Type.Object({ ...base, state: SessionState, recoveredOrphan: Type.Boolean() }, closed),
};
export type SessionDelta = {
	[K in keyof typeof SessionDeltas]: { type: K; payload: Static<(typeof SessionDeltas)[K]> };
}[keyof typeof SessionDeltas];
/**
 * The `_clio-coder/event` kinds this app opts into at `initialize`. Each is the
 * engine's own `BusChannels` value, never a renamed alias, so the wire frame
 * names its producer. The engine intersects this list with its own allowlist,
 * so a kind listed here that it does not forward costs nothing.
 */
export const ACP_EVENT_KINDS = [
	"safety.loopBlocked",
	"dispatch.enqueued",
	"dispatch.started",
	"dispatch.progress",
	"dispatch.completed",
	"dispatch.failed",
	"accountability.evidenceReady",
	"compaction.end",
	"context.warning",
	"safety.toolBudgetExceeded",
	"provider.health",
] as const;
