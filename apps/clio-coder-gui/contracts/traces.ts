import { type Static, Type } from "typebox";
import { PageCursor } from "./common.js";

const closed = { additionalProperties: false };
const text = Type.String();
/** Database identifiers include canonical session:<turn UUID> namespaces. These never authorize filesystem artifacts. */
export const TraceId = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]*$" });
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
		run_id: TraceId,
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
		cost_estimated: Type.Optional(count),
		cost_unknown: Type.Optional(count),
		api_calls: Type.Optional(count),
		missing_token_calls: Type.Optional(count),
		source: Type.Union([Type.Literal("dispatch"), Type.Literal("session")]),
	},
	closed,
);
export type TraceRun = Static<typeof TraceRun>;
export const TracePhase = Type.Object(
	{
		phase_id: TraceId,
		run_id: TraceId,
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
		total_cost_usd: count,
		cost_estimated: Type.Optional(count),
		cost_unknown: Type.Optional(count),
		api_calls: Type.Optional(count),
		missing_token_calls: Type.Optional(count),
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
		run_id: TraceId,
		phase_id: TraceId,
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
		run_id: TraceId,
		phase_id: TraceId,
		attempt: Type.Integer(),
		gate: text,
		passed: Type.Integer({ minimum: 0, maximum: 1 }),
		violations_json: text,
		checks_json: optionalText,
		created_at: text,
	},
	closed,
);
export const TraceProcess = Type.Object(
	{
		id: Type.Integer(),
		run_id: TraceId,
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
export const TraceParams = Type.Object({ runId: TraceId }, closed);
export const TraceLiveBatch = Type.Object(
	{ run: TraceRun, events: Type.Array(TraceEvent), cursor: RowCursor, hasMore: Type.Boolean() },
	closed,
);
export type TraceRequest =
	| { kind: "status" }
	| { kind: "runs"; query: Static<typeof TraceRunsQuery> }
	| { kind: "run" | "phases" | "gates" | "processes" | "receipt"; runId: string; full?: boolean }
	| { kind: "events" | "live"; runId: string; after: number; limit: number };
