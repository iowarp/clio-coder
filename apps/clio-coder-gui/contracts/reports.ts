import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const nullable = Type.Union([Type.String(), Type.Null()]);
const record = Type.Record(Type.String(), Type.Unknown());
const metrics = Type.Record(Type.String(), Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]));
const tokens = Type.Union([
	Type.Object({ measured: Type.Literal(false), runs: Type.Number(), measuredRuns: Type.Literal(0) }, closed),
	Type.Object(
		{
			measured: Type.Literal(true),
			runs: Type.Number(),
			measuredRuns: Type.Number(),
			input: Type.Number(),
			output: Type.Number(),
			total: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
		},
		closed,
	),
]);
export const EvalReport = Type.Object(
	{
		evalId: Id,
		startedAt: nullable,
		suiteId: Type.String(),
		clioCoder: Type.Object({ version: Type.String(), commit: nullable }, closed),
		environment: Type.Object({ platform: Type.String(), node: Type.String() }, closed),
		matrix: Type.Object(
			{ target: Type.String(), model: nullable, thinking: nullable, dimensions: Type.Optional(Type.Array(Type.String())) },
			closed,
		),
		servingConfiguration: Type.Union([record, Type.Null()]),
		summary: Type.Object(
			{
				runs: Type.Number(),
				passed: Type.Number(),
				failed: Type.Number(),
				passRate: Type.Number(),
				wallTimeMs: Type.Number(),
				tokens,
			},
			closed,
		),
	},
	closed,
);
export const EvalPage = Type.Object(
	{
		available: Type.Boolean(),
		stored: Type.Integer(),
		unreadable: Type.Integer(),
		items: Type.Array(EvalReport),
		nextCursor: nullable,
	},
	closed,
);
export const EvalDetail = Type.Object(
	{
		report: EvalReport,
		aggregates: Type.Union([Type.Array(record), Type.Null()]),
		results: Type.Array(
			Type.Object(
				{
					taskId: Type.String(),
					repeatIndex: Type.Number(),
					target: Type.Object({ id: Type.String(), model: nullable, thinking: nullable }, closed),
					pass: Type.Boolean(),
					failureClass: nullable,
					assignmentId: nullable,
					terminalReceiptRecorded: Type.Boolean(),
					metrics,
					attachments: Type.Integer(),
					verdict: Type.Union([record, Type.Null()]),
					behavioral: Type.Union([record, Type.Null()]),
					behavioralMetrics: Type.Union([record, Type.Null()]),
				},
				closed,
			),
		),
	},
	closed,
);
export type EvalRequest = { kind: "list"; limit: number; cursor?: string } | { kind: "detail"; id: string };
export const UsageReport = Type.Object(
	{
		schema: Type.Literal("experimental"),
		workspaceId: Id,
		windowDays: Type.Literal(30),
		from: Type.String(),
		to: Type.String(),
		facts: Type.Array(Type.Object({ name: Type.String(), values: record }, closed)),
		opportunities: Type.Array(
			Type.Object({ kind: Type.String(), suggestion: Type.String(), evidence: Type.String() }, closed),
		),
	},
	closed,
);
export type UsageReport = Static<typeof UsageReport>;
