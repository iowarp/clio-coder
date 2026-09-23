import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };
const name = Type.String({ maxLength: 64 });
const copy = Type.String({ maxLength: 512 });
/**
 * The engine bounds steer text at 16 KiB and a queue at 64 entries; these are
 * the same numbers, restated so a request that would be refused over ACP is
 * refused at this app's edge instead of costing a round trip.
 */
export const STEER_TEXT_MAX_BYTES = 16384;
export const QUEUE_MAX_ENTRIES = 64;
export const SteerMode = Type.Union([Type.Literal("next-slot"), Type.Literal("end-of-turn")]);
export type SteerMode = Static<typeof SteerMode>;
export const SteerRequest = Type.Object(
	{
		text: Type.String({ minLength: 1, maxLength: STEER_TEXT_MAX_BYTES, pattern: "\\S" }),
		mode: Type.Optional(SteerMode),
	},
	closed,
);
export type SteerRequest = Static<typeof SteerRequest>;
/** `refusal` is present exactly when `accepted` is false. */
export const SteerResult = Type.Object(
	{
		accepted: Type.Boolean(),
		queue: Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]),
		refusal: Type.Optional(copy),
	},
	closed,
);
export type SteerResult = Static<typeof SteerResult>;
export const QueueSnapshot = Type.Object(
	{
		steer: Type.Array(Type.String({ maxLength: STEER_TEXT_MAX_BYTES }), { maxItems: QUEUE_MAX_ENTRIES }),
		followUp: Type.Array(Type.String({ maxLength: STEER_TEXT_MAX_BYTES }), { maxItems: QUEUE_MAX_ENTRIES }),
	},
	closed,
);
export type QueueSnapshot = Static<typeof QueueSnapshot>;
/** Both queues drain together, and the returned texts are the client's to re-send. */
export const QueueCleared = Type.Object(
	{ restored: Type.Array(Type.String({ maxLength: STEER_TEXT_MAX_BYTES }), { maxItems: 2 * QUEUE_MAX_ENTRIES }) },
	closed,
);
export type QueueCleared = Static<typeof QueueCleared>;
export const InterruptRequest = Type.Object({ reason: Type.Optional(Type.String({ maxLength: 256 })) }, closed);
/**
 * `cancelled: false` with a `refusal` means nothing was cancelled: a prompt was
 * not running, or the engine is holding an attached dispatch or a parked
 * permission. The unconditional stop is still the turn-cancel route.
 */
export const InterruptResult = Type.Object({ cancelled: Type.Boolean(), refusal: Type.Optional(copy) }, closed);
export type InterruptResult = Static<typeof InterruptResult>;
export const DispatchSteerRequest = Type.Object(
	{
		runId: Type.String({ minLength: 1, maxLength: 128 }),
		action: Type.Union([Type.Literal("guide"), Type.Literal("cancel")]),
		message: Type.Optional(Type.String({ minLength: 1, maxLength: STEER_TEXT_MAX_BYTES, pattern: "\\S" })),
	},
	closed,
);
/** `accepted` means QUEUED on the worker's stdin. Delivery is acknowledged later and out of band. */
export const DispatchSteerResult = Type.Object({ accepted: Type.Boolean(), reason: Type.Optional(name) }, closed);
export type DispatchSteerResult = Static<typeof DispatchSteerResult>;

const flagSpec = Type.Object(
	{
		name,
		takesValue: Type.Optional(Type.Boolean()),
		repeatable: Type.Optional(Type.Boolean()),
		values: Type.Optional(Type.Array(name, { maxItems: 64 })),
		valueName: Type.Optional(name),
		completionSlot: Type.Optional(name),
	},
	closed,
);
const positionalSpec = Type.Object(
	{
		name,
		required: Type.Boolean(),
		values: Type.Optional(Type.Array(name, { maxItems: 64 })),
		rest: Type.Optional(Type.Boolean()),
		completionSlot: Type.Optional(name),
	},
	closed,
);
/**
 * One level of subcommands, not a recursive grammar. The registry's own
 * commands nest exactly once (`/context compact`, `/tasks hand`), and a schema
 * that admitted arbitrary depth would validate a shape no producer emits.
 */
const leafArgs = Type.Object(
	{
		flags: Type.Optional(Type.Array(flagSpec, { maxItems: 32 })),
		positionals: Type.Optional(Type.Array(positionalSpec, { maxItems: 8 })),
	},
	closed,
);
const commandArgs = Type.Object(
	{
		flags: Type.Optional(Type.Array(flagSpec, { maxItems: 32 })),
		positionals: Type.Optional(Type.Array(positionalSpec, { maxItems: 8 })),
		subcommands: Type.Optional(Type.Record(Type.String(), leafArgs)),
	},
	closed,
);
export const CommandDescriptor = Type.Object(
	{
		name,
		summary: copy,
		usage: copy,
		group: name,
		args: commandArgs,
		subcommandSummaries: Type.Optional(Type.Record(Type.String(), copy)),
		/** The bare command is refused; only the projected subcommands are admitted. */
		requiresSubcommand: Type.Optional(Type.Literal(true)),
		/** The result is "started"; real output arrives as fleet events. */
		streams: Type.Optional(Type.Literal("dispatch")),
		/** The command puts a user turn into the session outside any prompt. */
		injectsUserTurn: Type.Optional(Type.Literal(true)),
	},
	closed,
);
export type CommandDescriptor = Static<typeof CommandDescriptor>;
export const CommandCatalog = Type.Object(
	{ version: Type.Literal(1), commands: Type.Array(CommandDescriptor, { maxItems: 64 }) },
	closed,
);
export type CommandCatalog = Static<typeof CommandCatalog>;
export const CommandRequest = Type.Object(
	{
		command: name,
		argv: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 })),
	},
	closed,
);
export type CommandRequest = Static<typeof CommandRequest>;
export const CommandResult = Type.Object(
	{
		level: Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("warn"), Type.Literal("error")]),
		lines: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 201 }),
	},
	closed,
);
export type CommandResult = Static<typeof CommandResult>;
