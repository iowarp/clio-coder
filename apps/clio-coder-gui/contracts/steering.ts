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
export const QueueKind = Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]);
export type QueueKind = Static<typeof QueueKind>;
/** One waiting message. `pinned` means the operator chose its slot, so steering triage leaves it there. */
export const QueueEntry = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		kind: QueueKind,
		text: Type.String({ maxLength: STEER_TEXT_MAX_BYTES }),
		enqueuedAt: Type.Number(),
		pinned: Type.Boolean(),
	},
	closed,
);
export type QueueEntry = Static<typeof QueueEntry>;
const queueEntries = Type.Array(QueueEntry, { maxItems: QUEUE_MAX_ENTRIES });
/** `entries` is the queue in delivery order, with ids; an engine without the `queue` capability omits it. */
export const QueueSnapshot = Type.Object(
	{
		steer: Type.Array(Type.String({ maxLength: STEER_TEXT_MAX_BYTES }), { maxItems: QUEUE_MAX_ENTRIES }),
		followUp: Type.Array(Type.String({ maxLength: STEER_TEXT_MAX_BYTES }), { maxItems: QUEUE_MAX_ENTRIES }),
		entries: Type.Optional(queueEntries),
	},
	closed,
);
export type QueueSnapshot = Static<typeof QueueSnapshot>;
/** `_clio-coder/session/queue_changed`, as the event stream carries it. */
export const QueueChanged = Type.Object({ sessionId: Type.String({ maxLength: 128 }), entries: queueEntries }, closed);
/** `delta` goes only with `move` and `kind` only with `set_kind`; the engine refuses any other pairing. */
export const QueueEditRequest = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		op: Type.Union([
			Type.Literal("remove"),
			Type.Literal("restore"),
			Type.Literal("move"),
			Type.Literal("set_kind"),
			Type.Literal("send_now"),
		]),
		delta: Type.Optional(Type.Union([Type.Literal(-1), Type.Literal(1)])),
		kind: Type.Optional(QueueKind),
	},
	closed,
);
export type QueueEditRequest = Static<typeof QueueEditRequest>;
/**
 * `applied: false` names why in `reason` (`stale-entry`, `at-edge`, and for
 * `send_now` `no-active-prompt`, `prompt-ending`, `not-streaming`). `text` is
 * what `restore` and `send_now` took out; `delivery: "next-slot"` with a
 * `refusal` means the engine could not interrupt and queued the text first.
 */
export const QueueEditResult = Type.Object(
	{
		applied: Type.Boolean(),
		reason: Type.Optional(name),
		text: Type.Optional(Type.String({ maxLength: STEER_TEXT_MAX_BYTES })),
		delivery: Type.Optional(Type.Union([Type.Literal("interrupt"), Type.Literal("next-slot")])),
		refusal: Type.Optional(copy),
		entries: queueEntries,
	},
	closed,
);
export type QueueEditResult = Static<typeof QueueEditResult>;
/** The terminal's `!` line: one line, run in the session's sandbox between turns. */
export const ShellRequest = Type.Object(
	{
		command: Type.String({ minLength: 1, maxLength: STEER_TEXT_MAX_BYTES, pattern: "^[^\\n\\r]*\\S[^\\n\\r]*$" }),
		/** The terminal's `!!`: the output is recorded and kept out of Clio's context. */
		excludeFromContext: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type ShellRequest = Static<typeof ShellRequest>;
/** What `_clio-coder/session/shell` answers once the line has ended; the output itself arrives as tool frames. */
export const ShellOutcome = Type.Object(
	{
		cancelled: Type.Boolean(),
		timedOut: Type.Boolean(),
		excludedFromContext: Type.Boolean(),
		unlabeled: Type.Optional(Type.Boolean()),
	},
	closed,
);
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
		/** The command's calls and approvals belong to a conversation turn, so it is sent as one. */
		promptTurn: Type.Optional(Type.Literal(true)),
		/** Subcommands sent as a conversation turn, as promptTurn does for a whole command. */
		promptTurnSubcommands: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
	},
	closed,
);
export type CommandDescriptor = Static<typeof CommandDescriptor>;
export const CommandCatalog = Type.Object(
	{
		version: Type.Literal(1),
		commands: Type.Array(CommandDescriptor, { maxItems: 64 }),
		/** Loaded prompt templates a `/name` line expands to; absent from a build that does not say. */
		prompts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 })),
	},
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
