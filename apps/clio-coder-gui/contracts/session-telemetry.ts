import type { Static } from "typebox";
import { Type } from "typebox";
import { Autonomy } from "./autonomy.js";
import { ContextLedger } from "./context-ledger.js";
import { SessionReadouts } from "./readouts.js";

import { TelemetrySession } from "./telemetry.js";
import { AcpUsageMetaSchema } from "./wire.js";

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 4096 });
const nullableText = Type.Union([text, Type.Null()]);
const count = Type.Integer({ minimum: 0 });
const nullableCount = Type.Union([count, Type.Null()]);

/** Live usage preserves the read model's quantities and displays (#434). */
export const LiveUsage = Type.Object(
	{
		context: Type.Optional(ContextLedger),
		turn: Type.Union([AcpUsageMetaSchema.properties.quantities, Type.Null()]),
		session: Type.Union([TelemetrySession, Type.Null()]),
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
		/** Tasks dropped from the board, which the engine leaves out of `entries` and counts here. */
		cancelled: Type.Optional(count),
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

/**
 * The latest operator memory capture ("remember that ...", `# ...`, `/remember`), as the ACP notice chunk
 * carries it under `_meta["clio-coder/memory-capture"]`. The chip's actions are `remember undo <captureId>`
 * and `remember scope <scope> <captureId>` through the session command route.
 */
export const MemoryCapture = Type.Object(
	{
		version: Type.Literal(1),
		captureId: Type.String({ maxLength: 64 }),
		action: Type.Union([
			Type.Literal("remembered"),
			Type.Literal("forgot"),
			Type.Literal("undone"),
			Type.Literal("refused"),
		]),
		scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("global")])),
		kind: Type.Optional(
			Type.Union([Type.Literal("fact"), Type.Literal("preference"), Type.Literal("rule"), Type.Literal("command")]),
		),
		text: Type.String({ maxLength: 1024 }),
	},
	closed,
);
export type MemoryCapture = Static<typeof MemoryCapture>;

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
		memoryCapture: Type.Optional(MemoryCapture),
		notices: Type.Optional(Type.Array(Type.String({ maxLength: 16384 }), { maxItems: 32 })),
		/** Moves on each `available_commands_update`, so a client re-reads the command list (it carries no list itself). */
		commandsRevision: Type.Optional(count),
		readouts: Type.Optional(SessionReadouts),
	},
	closed,
);
export type SessionTelemetry = Static<typeof SessionTelemetry>;
