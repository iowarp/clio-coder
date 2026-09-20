import { type Static, Type } from "typebox";
import { Id, PageCursor } from "./common.js";

const closed = { additionalProperties: false };
const text = Type.String();
const optionalText = Type.Union([text, Type.Null()]);
const count = Type.Union([Type.Number(), Type.Null()]);
export const TraceStatus = Type.Object(
	{
		available: Type.Boolean(),
		schemaVersion: Type.Union([Type.Integer(), Type.Null()]),
		retentionPolicy: Type.Object({ maxAgeDays: Type.Integer(), maxBytes: Type.Integer() }, closed),
	},
	closed,
);
export const TraceRun = Type.Object(
	{
		run_id: text,
		assignment_id: text,
		request: optionalText,
		status: text,
		agent: text,
		target: text,
		model: text,
		runtime: text,
		node: optionalText,
		started_at: text,
		ended_at: optionalText,
		total_tokens: count,
		total_cost_usd: count,
		source: Type.Union([Type.Literal("dispatch"), Type.Literal("session")]),
	},
	closed,
);
export type TraceRun = Static<typeof TraceRun>;
export const TracePhase = Type.Object(
	{
		phase_id: text,
		run_id: text,
		seq: Type.Integer(),
		name: text,
		kind: text,
		owner: text,
		description: optionalText,
		status: text,
		attempt: Type.Integer(),
		retries: Type.Integer(),
		error: optionalText,
		started_at: optionalText,
		ended_at: optionalText,
		input_tokens: count,
		output_tokens: count,
		cache_read_tokens: count,
		cache_write_tokens: count,
		cache_write_1h_tokens: Type.Optional(count),
		reasoning_tokens: count,
		total_tokens: count,
		input_cost_usd: count,
		output_cost_usd: count,
		cache_read_cost_usd: count,
		cache_write_cost_usd: count,
		total_cost_usd: count,
		context_tokens: count,
		context_window: count,
	},
	closed,
);
export type TracePhase = Static<typeof TracePhase>;
export const TraceEvent = Type.Object(
	{
		rowid: Type.Integer({ minimum: 1 }),
		event_id: text,
		run_id: text,
		phase_id: text,
		parent_id: optionalText,
		type: text,
		name: text,
		payload_json: optionalText,
		tokens: count,
		started_at: text,
		ended_at: optionalText,
	},
	closed,
);
export type TraceEvent = Static<typeof TraceEvent>;
export const TraceGate = Type.Object(
	{
		id: Type.Integer(),
		run_id: text,
		phase_id: text,
		attempt: Type.Integer(),
		gate: text,
		passed: Type.Integer({ minimum: 0, maximum: 1 }),
		violations_json: text,
		checks_json: optionalText,
		created_at: text,
	},
	closed,
);
export const TraceEnvelope = Type.Object(
	{
		envelope_id: text,
		run_id: text,
		phase_id: text,
		agent: text,
		output_type: text,
		payload_json: text,
		valid: Type.Integer({ minimum: 0, maximum: 1 }),
		attempt: Type.Integer(),
		created_at: text,
	},
	closed,
);
export const TraceProcess = Type.Object(
	{
		id: Type.Integer(),
		run_id: text,
		kind: text,
		name: text,
		pid: Type.Integer(),
		command: text,
		command_digest: text,
		started_at: text,
		ended_at: optionalText,
		host: Type.Optional(optionalText),
		birth_token: Type.Optional(optionalText),
	},
	closed,
);
export const JsonRecord = Type.Record(Type.String(), Type.Unknown());
export const TraceReceipt = Type.Object(
	{ receipt: Type.Union([JsonRecord, Type.Null()]), evidence: Type.Union([JsonRecord, Type.Null()]) },
	closed,
);
export const TraceRunsQuery = Type.Object(
	{
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		cursor: Type.Optional(PageCursor),
		source: Type.Optional(Type.Union([Type.Literal("dispatch"), Type.Literal("session")])),
		status: Type.Optional(
			Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("success"), Type.Literal("fail")]),
		),
		q: Type.Optional(Type.String({ maxLength: 256 })),
	},
	closed,
);
export const TraceRunsPage = Type.Object(
	{ runs: Type.Array(TraceRun), nextCursor: Type.Union([PageCursor, Type.Null()]) },
	closed,
);
export const RowCursor = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const TraceEventsQuery = Type.Object(
	{ after: Type.Optional(RowCursor), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) },
	closed,
);
export const TraceEventsPage = Type.Object(
	{ events: Type.Array(TraceEvent), cursor: RowCursor, hasMore: Type.Boolean() },
	closed,
);
export const TraceParams = Type.Object({ runId: Id }, closed);
export const TraceLiveBatch = Type.Object(
	{ run: TraceRun, events: Type.Array(TraceEvent), cursor: RowCursor, hasMore: Type.Boolean() },
	closed,
);
export type TraceRequest =
	| { kind: "status" }
	| { kind: "runs"; query: Static<typeof TraceRunsQuery> }
	| { kind: "run" | "phases" | "gates" | "envelopes" | "processes" | "receipt"; runId: string; full?: boolean }
	| { kind: "events" | "live"; runId: string; after: number; limit: number };
