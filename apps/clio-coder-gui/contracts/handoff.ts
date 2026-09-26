import { type Static, Type } from "typebox";
import { Id } from "./common.js";

// `_clio-coder/session/handoff/*`: the terminal's /handoff. A draft is reviewed and edited here and
// nothing is written until it is committed. The agent bounds the document at 128 KiB and a reason at
// 2 KiB; these schemas restate that.
const closed = { additionalProperties: false };
const method = Type.String({ maxLength: 128 });
const HandoffId = Type.String({ minLength: 1, maxLength: 128 });
const Document = Type.String({ maxLength: 131072 });

export const HandoffCapability = Type.Object(
	{ version: Type.Literal(1), prepare: method, commit: method, cancel: method },
	closed,
);
export type HandoffCapability = Static<typeof HandoffCapability>;

export const HandoffRefused = Type.Object(
	{
		status: Type.Literal("refused"),
		level: Type.Union([Type.Literal("warn"), Type.Literal("error")]),
		code: Type.String({ maxLength: 64 }),
		reason: Type.String({ maxLength: 2100 }),
	},
	closed,
);
export type HandoffRefused = Static<typeof HandoffRefused>;

export const HandoffPrepareRequest = Type.Object({ goal: Type.String({ maxLength: 2048 }) }, closed);
export const HandoffDraft = Type.Union([
	Type.Object(
		{
			status: Type.Literal("ready"),
			handoffId: HandoffId,
			goal: Type.String({ maxLength: 2048 }),
			fromSessionId: Id,
			document: Document,
		},
		closed,
	),
	HandoffRefused,
]);
export type HandoffDraft = Static<typeof HandoffDraft>;

export const HandoffCommitRequest = Type.Object({ handoffId: HandoffId, document: Document }, closed);
export const HandoffCommitted = Type.Union([
	Type.Object(
		{
			status: Type.Literal("committed"),
			sessionId: Id,
			fromSessionId: Id,
			warnings: Type.Array(Type.String({ maxLength: 2100 }), { maxItems: 8 }),
		},
		closed,
	),
	HandoffRefused,
]);
export type HandoffCommitted = Static<typeof HandoffCommitted>;

export const HandoffCancelRequest = Type.Object({ handoffId: HandoffId }, closed);
export const HandoffCancelled = Type.Object({ cancelled: Type.Boolean() }, closed);
