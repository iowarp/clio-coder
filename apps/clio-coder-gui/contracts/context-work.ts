import { Type } from "typebox";
import type {
	ContextOperation as CanonicalOperation,
	ContextOperationStatus as CanonicalStatus,
	ContextActivityPayload,
} from "./wire.js";

// The GUI validates the canonical core evidence at its JSON boundary. Types remain core-owned.
const closed = { additionalProperties: false };
const text = Type.String();
const count = Type.Integer({ minimum: 0 });
const kind = Type.Union([
	Type.Literal("context-init"),
	Type.Literal("context-clear"),
	Type.Literal("context-refresh"),
	Type.Literal("context-recall"),
	Type.Literal("context-recover"),
	Type.Literal("compaction"),
]);
const phase = Type.Union([
	Type.Literal("scan"),
	Type.Literal("codewiki"),
	Type.Literal("generate"),
	Type.Literal("clio-md"),
	Type.Literal("state"),
	Type.Literal("compact"),
	Type.Literal("summarize"),
	Type.Literal("done"),
]);
export const ContextOperation = Type.Object(
	{
		version: Type.Literal(1),
		id: Type.String({ maxLength: 128 }),
		kind,
		sessionId: Type.Union([text, Type.Null()]),
		cwd: text,
		origin: Type.Union([Type.Literal("operator"), Type.Literal("automatic")]),
		reason: text,
		startedAt: text,
		elapsedMs: Type.Optional(count),
		outcome: Type.Optional(
			Type.Union([
				Type.Literal("completed"),
				Type.Literal("previewed"),
				Type.Literal("unchanged"),
				Type.Literal("cancelled"),
				Type.Literal("failed"),
			]),
		),
		facts: Type.Optional(
			Type.Array(
				Type.Object(
					{
						kind: Type.Union([
							Type.Literal("created"),
							Type.Literal("updated"),
							Type.Literal("indexed"),
							Type.Literal("ingested"),
							Type.Literal("preserved"),
							Type.Literal("omitted"),
							Type.Literal("removed"),
							Type.Literal("read"),
							Type.Literal("summarized"),
							Type.Literal("recalled"),
						]),
						unit: Type.Union([
							Type.Literal("paths"),
							Type.Literal("source-files"),
							Type.Literal("rules"),
							Type.Literal("messages"),
							Type.Literal("entries"),
							Type.Literal("observations"),
						]),
						count: Type.Optional(count),
						paths: Type.Optional(Type.Array(text)),
					},
					closed,
				),
			),
		),
		warnings: Type.Optional(Type.Array(text)),
		tokens: Type.Optional(Type.Object({ before: count, after: count, basis: Type.Literal("runtime-estimate") }, closed)),
	},
	closed,
);
export type ContextOperation = CanonicalOperation;

export const ContextActivity = Type.Object(
	{
		operation: Type.Optional(ContextOperation),
		kind,
		phase,
		status: Type.Union([
			Type.Literal("started"),
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
		]),
		message: text,
		at: Type.Number(),
		current: Type.Optional(count),
		total: Type.Optional(count),
		detail: Type.Optional(text),
		stages: Type.Optional(Type.Array(phase)),
		timing: Type.Optional(Type.Object({ runId: text, startedAtMs: Type.Number(), timeoutMs: Type.Number() }, closed)),
	},
	closed,
);
export type ContextActivity = ContextActivityPayload;

export const ContextOperationStatus = Type.Object(
	{
		version: Type.Literal(1),
		active: Type.Union([ContextActivity, Type.Null()]),
		latest: Type.Union([ContextOperation, Type.Null()]),
	},
	closed,
);
export type ContextOperationStatus = CanonicalStatus;
