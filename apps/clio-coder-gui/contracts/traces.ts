import type { Static } from "typebox";
import { Type } from "typebox";
import { Id, PageCursor } from "./common.js";
import { TelemetryRunRow } from "./telemetry.js";

/**
 * Trace history is the run journals (#434 §11.3): each run's read-model row, joined to the dispatch ledger's row for
 * the identity a content-free journal does not hold. A run's calls, feed and process lifecycle are its run timeline;
 * nothing here reads trace.sqlite.
 */
const closed = { additionalProperties: false };
const text = Type.String();
const optionalText = Type.Union([text, Type.Null()]);
/** `unknown` is a run the ledger does not hold whose journal has not settled; never read as success or failure. */
export const TraceRunStatus = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("success"),
	Type.Literal("fail"),
	Type.Literal("unknown"),
]);
export type TraceRunStatus = Static<typeof TraceRunStatus>;
/** The dispatch ledger's row for a run: what was asked, of whom, on which route. */
export const TraceIdentity = Type.Object(
	{
		agentId: text,
		task: text,
		targetId: text,
		model: text,
		runtimeId: text,
		node: optionalText,
		status: text,
		outcome: optionalText,
		startedAt: text,
		endedAt: optionalText,
		sessionId: optionalText,
		parentRunId: optionalText,
		rootRunId: optionalText,
	},
	closed,
);
export type TraceIdentity = Static<typeof TraceIdentity>;
export const TraceRun = Type.Object(
	{
		runId: Id,
		status: TraceRunStatus,
		/** The journal's last write, the history's order; null for a run directory with no journal. */
		writtenAt: optionalText,
		/** Null for a run the ledger does not hold: a standalone run, or a row the ledger has since dropped. */
		identity: Type.Union([TraceIdentity, Type.Null()]),
		/** Tokens and spend come from the run journal through the read model (#434). */
		telemetry: TelemetryRunRow,
	},
	closed,
);
export type TraceRun = Static<typeof TraceRun>;
export const JsonRecord = Type.Record(Type.String(), Type.Unknown());
export const TraceReceipt = Type.Object(
	{ receipt: Type.Union([JsonRecord, Type.Null()]), evidence: Type.Union([JsonRecord, Type.Null()]) },
	closed,
);
export const TraceRunsQuery = Type.Object(
	{
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		cursor: Type.Optional(PageCursor),
		status: Type.Optional(TraceRunStatus),
		q: Type.Optional(Type.String({ maxLength: 256 })),
	},
	closed,
);
export const TraceRunsPage = Type.Object(
	{ runs: Type.Array(TraceRun), nextCursor: Type.Union([PageCursor, Type.Null()]) },
	closed,
);
export const TraceParams = Type.Object({ runId: Id }, closed);
export type TraceRequest =
	| { kind: "runs"; query: Static<typeof TraceRunsQuery> }
	| { kind: "run"; runId: string }
	| { kind: "receipt"; runId: string; full?: boolean };
