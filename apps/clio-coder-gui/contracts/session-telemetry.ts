import type { Static } from "typebox";
import { Type } from "typebox";
import { Autonomy } from "./autonomy.js";
import { ContextLedger } from "./context-ledger.js";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 4096 });
const nullableText = Type.Union([text, Type.Null()]);
const count = Type.Integer({ minimum: 0 });
const nullableCount = Type.Union([count, Type.Null()]);

/**
 * The live hint a `usage_update` carries between cold reads of the session DTO, which is the authoritative spend
 * (#434 §11.2). Every count is nullable: null is a value the frame could not vouch for, a window the agent did not
 * know or tokens from calls that reported none, and is drawn as not recorded, never as 0 (R1).
 */
export const LiveUsage = Type.Object(
	{
		used: nullableCount,
		size: nullableCount,
		cost: Type.Optional(Type.Object({ amount: Type.Number({ minimum: 0 }), currency: text }, closed)),
		context: Type.Optional(ContextLedger),
		session: Type.Optional(
			Type.Object(
				{
					input: nullableCount,
					output: nullableCount,
					cacheRead: nullableCount,
					cacheWrite: nullableCount,
					reasoning: nullableCount,
					totalTokens: nullableCount,
					calls: Type.Optional(count),
					unknownCallCoverageRuns: Type.Optional(count),
					missingTokenCalls: Type.Optional(count),
					hasEstimatedCost: Type.Optional(Type.Boolean()),
					costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
					costDisplay: Type.Optional(text),
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

/**
 * A session cost ceiling stop, as the ACP notice chunk carries it under
 * `_meta["clio-coder/budget"]` (#424). It stands while the parked request
 * waits for a raise and clears once the turn produces output again.
 */
export const BudgetBlock = Type.Object(
	{
		currentDisplay: Type.Optional(text),
		ceilingDisplay: Type.Optional(text),
		raiseDisplay: Type.Optional(text),
		level: Type.Union([Type.Literal("at"), Type.Literal("over")]),
		currentUsd: Type.Number({ minimum: 0 }),
		ceilingUsd: Type.Number({ minimum: 0 }),
		contextTokens: Type.Union([count, Type.Null()]),
		raiseToUsd: Type.Number({ minimum: 0 }),
		setting: text,
	},
	closed,
);
export type BudgetBlock = Static<typeof BudgetBlock>;

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
		autonomy: Type.Optional(Autonomy),
		eggs: Type.Optional(ActiveEggs),
		memory: Type.Optional(MemoryGuardian),
		usage: Type.Optional(LiveUsage),
		plan: Type.Optional(SessionPlan),
		workspace: Type.Optional(SessionWorkspace),
		trust: Type.Optional(ProjectTrust),
		budget: Type.Optional(BudgetBlock),
		notices: Type.Optional(Type.Array(Type.String({ maxLength: 16384 }), { maxItems: 32 })),
	},
	closed,
);
export type SessionTelemetry = Static<typeof SessionTelemetry>;
