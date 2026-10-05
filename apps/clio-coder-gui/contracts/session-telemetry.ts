import type { Static } from "typebox";
import { Type } from "typebox";
import { ContextLedger } from "./context-ledger.js";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 4096 });
const nullableText = Type.Union([text, Type.Null()]);
const count = Type.Integer({ minimum: 0 });
const nullableCount = Type.Union([count, Type.Null()]);

export const LiveUsage = Type.Object(
	{
		used: count,
		size: count,
		cost: Type.Optional(Type.Object({ amount: Type.Number({ minimum: 0 }), currency: text }, closed)),
		context: Type.Optional(ContextLedger),
		session: Type.Optional(
			Type.Object(
				{
					input: count,
					output: count,
					cacheRead: count,
					cacheWrite: count,
					reasoning: count,
					totalTokens: count,
					costUsd: Type.Number({ minimum: 0 }),
					costProvenance: Type.Union([
						Type.Literal("known"),
						Type.Literal("known_free"),
						Type.Literal("estimated"),
						Type.Literal("unknown"),
					]),
				},
				closed,
			),
		),
	},
	closed,
);
export type LiveUsage = Static<typeof LiveUsage>;

export const SessionPlan = Type.Object(
	{
		title: nullableText,
		entries: Type.Array(
			Type.Object(
				{
					id: text,
					content: text,
					status: Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("completed"),
						Type.Literal("blocked"),
					]),
					reason: nullableText,
				},
				closed,
			),
			{ maxItems: 100 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export type SessionPlan = Static<typeof SessionPlan>;

export const SessionWorkspace = Type.Object(
	{
		version: Type.Literal(1),
		cwd: text,
		isGit: Type.Boolean(),
		branch: nullableText,
		dirty: Type.Union([Type.Boolean(), Type.Null()]),
		ahead: nullableCount,
		behind: nullableCount,
		remoteUrl: nullableText,
		projectType: text,
		capturedAt: text,
	},
	closed,
);
export type SessionWorkspace = Static<typeof SessionWorkspace>;

export const ProjectTrust = Type.Object(
	{
		ignored: Type.Array(Type.Object({ surface: text, file: text, verdict: text, fix: text }, closed), { maxItems: 64 }),
	},
	closed,
);

export const ActiveEggs = Type.Array(Type.Literal("duck"), { maxItems: 1 });

/** What Clio's always-on memory guardian is doing, as last pushed. */
export const MemoryGuardian = Type.Object(
	{
		state: Type.Union([
			Type.Literal("off"),
			Type.Literal("idle"),
			Type.Literal("reviewing"),
			Type.Literal("waiting-capacity"),
			Type.Literal("unavailable"),
		]),
	},
	closed,
);
export type MemoryGuardian = Static<typeof MemoryGuardian>;

export const SessionTelemetry = Type.Object(
	{
		eggs: Type.Optional(ActiveEggs),
		memory: Type.Optional(MemoryGuardian),
		usage: Type.Optional(LiveUsage),
		plan: Type.Optional(SessionPlan),
		workspace: Type.Optional(SessionWorkspace),
		trust: Type.Optional(ProjectTrust),
		notices: Type.Optional(Type.Array(Type.String({ maxLength: 16384 }), { maxItems: 32 })),
	},
	closed,
);
export type SessionTelemetry = Static<typeof SessionTelemetry>;
