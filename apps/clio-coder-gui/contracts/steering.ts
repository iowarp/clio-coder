import type { Static } from "typebox";
import { Type } from "typebox";
import {
	AcpCommandCatalogSchema,
	AcpCommandDescriptorSchema,
	AcpCommandResultSchema,
	AcpDispatchSteerResultSchema,
	AcpInterruptResultSchema,
	AcpQueueChangedSchema,
	AcpQueueClearedSchema,
	AcpQueueEditResultSchema,
	AcpQueueEntrySchema,
	AcpQueueSnapshotSchema,
	AcpShellOutcomeSchema,
	AcpSteerResultSchema,
} from "./wire.js";

const closed = { additionalProperties: false };
const name = Type.String({ maxLength: 64 });

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
export const SteerResult = AcpSteerResultSchema;
export type SteerResult = Static<typeof SteerResult>;
export const QueueKind = Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]);
export type QueueKind = Static<typeof QueueKind>;
/** One waiting message. `pinned` means the operator chose its slot, so steering triage leaves it there. */
export const QueueEntry = AcpQueueEntrySchema;
export type QueueEntry = Static<typeof QueueEntry>;

/** `entries` is the queue in delivery order, with ids; an engine without the `queue` capability omits it. */
export const QueueSnapshot = AcpQueueSnapshotSchema;
export type QueueSnapshot = Static<typeof QueueSnapshot>;
/** `_clio-coder/session/queue_changed`, as the event stream carries it. */
export const QueueChanged = AcpQueueChangedSchema;
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
export const QueueEditResult = AcpQueueEditResultSchema;
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
export const ShellOutcome = AcpShellOutcomeSchema;
/** Both queues drain together, and the returned texts are the client's to re-send. */
export const QueueCleared = AcpQueueClearedSchema;
export type QueueCleared = Static<typeof QueueCleared>;
export const InterruptRequest = Type.Object({ reason: Type.Optional(Type.String({ maxLength: 256 })) }, closed);
/**
 * `cancelled: false` with a `refusal` means nothing was cancelled: a prompt was
 * not running, or the engine is holding an attached dispatch or a parked
 * permission. The unconditional stop is still the turn-cancel route.
 */
export const InterruptResult = AcpInterruptResultSchema;
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
export const DispatchSteerResult = AcpDispatchSteerResultSchema;
export type DispatchSteerResult = Static<typeof DispatchSteerResult>;

/**
 * One level of subcommands, not a recursive grammar. The registry's own
 * commands nest exactly once (`/context compact`, `/tasks hand`), and a schema
 * that admitted arbitrary depth would validate a shape no producer emits.
 */

export const CommandDescriptor = AcpCommandDescriptorSchema;
export type CommandDescriptor = Static<typeof CommandDescriptor>;
export const CommandCatalog = AcpCommandCatalogSchema;
export type CommandCatalog = Static<typeof CommandCatalog>;
export const CommandRequest = Type.Object(
	{
		command: name,
		argv: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 })),
	},
	closed,
);
export type CommandRequest = Static<typeof CommandRequest>;
export const CommandResult = AcpCommandResultSchema;
export type CommandResult = Static<typeof CommandResult>;
