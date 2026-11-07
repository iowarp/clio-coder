import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { TELEMETRY_DTO_SCHEMAS } from "./wire.js";

const closed = { additionalProperties: false };
const record = Type.Record(Type.String(), Type.Unknown());
const quantity = TELEMETRY_DTO_SCHEMAS.session.properties.own.properties.tokens.properties.input;
const shown = Type.Omit(quantity, ["ref"]);
const latency = Type.Object({ p50: shown, p95: shown, measured: shown, missing: shown }, closed);
export const UsagePerformance = Type.Object(
	{
		coverage: Type.Object({ journals: Type.Integer(), unavailable: Type.Integer(), gaps: Type.Integer() }, closed),
		totals: Type.Object({ toolCalls: shown, toolErrors: shown, toolBlocked: shown, compactions: shown }, closed),
		tools: Type.Array(
			Type.Object(
				{ tool: Type.String(), calls: shown, ok: shown, errors: shown, blocked: shown, success: shown, latency },
				closed,
			),
		),
		compactionOutcomes: Type.Object({ committed: shown, discarded: shown, failed: shown, unresolved: shown }, closed),
		compactions: Type.Array(
			Type.Object(
				{
					at: Type.String(),
					recordId: Type.String(),
					sessionId: Type.Union([Type.String(), Type.Null()]),
					runId: Type.Union([Type.String(), Type.Null()]),
					outcome: Type.String(),
					checkpointTurnId: Type.Union([Type.String(), Type.Null()]),
				},
				closed,
			),
		),
		sessions: Type.Array(
			Type.Object(
				{
					sessionId: Type.String(),
					startedAt: Type.Union([Type.String(), Type.Null()]),
					lastAt: Type.Union([Type.String(), Type.Null()]),
					calls: quantity,
					tokens: quantity,
					usd: quantity,
					cacheShare: quantity,
					ttft: latency,
					modelTime: latency,
					trend: Type.Array(Type.Union([Type.Number(), Type.Null()])),
					toolCalls: shown,
					toolErrors: shown,
					compactions: shown,
					journal: TELEMETRY_DTO_SCHEMAS.session.properties.journal,
				},
				closed,
			),
		),
		sessionCount: Type.Integer(),
	},
	closed,
);
export type UsagePerformance = Static<typeof UsagePerformance>;
export const UsageReport = Type.Object(
	{
		schema: Type.Literal("experimental"),
		workspaceId: Id,
		windowDays: Type.Literal(30),
		from: Type.String(),
		to: Type.String(),
		facts: Type.Array(Type.Object({ name: Type.String(), values: record }, closed)),
		performance: Type.Optional(UsagePerformance),
		opportunities: Type.Array(
			Type.Object({ kind: Type.String(), suggestion: Type.String(), evidence: Type.String() }, closed),
		),
	},
	closed,
);
export type UsageReport = Static<typeof UsageReport>;
