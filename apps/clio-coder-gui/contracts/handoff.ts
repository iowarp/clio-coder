import {
	AcpHandoffCancelledSchema,
	AcpHandoffCommittedSchema,
	AcpHandoffDraftSchema,
	AcpHandoffCapability as HandoffCapability,
} from "./wire.js";

export { HandoffCapability };

import type { Static } from "typebox";
import { Type } from "typebox";

// `_clio-coder/session/handoff/*`: the terminal's /handoff. A draft is reviewed and edited here and
// nothing is written until it is committed. The agent bounds the document at 128 KiB and a reason at
// 2 KiB; these schemas restate that.
const closed = { additionalProperties: false };
const HandoffId = Type.String({ minLength: 1, maxLength: 128 });
const Document = Type.String({ maxLength: 131072 });

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
export const HandoffDraft = AcpHandoffDraftSchema;
export type HandoffDraft = Static<typeof HandoffDraft>;

export const HandoffCommitRequest = Type.Object({ handoffId: HandoffId, document: Document }, closed);
export const HandoffCommitted = AcpHandoffCommittedSchema;
export type HandoffCommitted = Static<typeof HandoffCommitted>;

export const HandoffCancelRequest = Type.Object({ handoffId: HandoffId }, closed);
export const HandoffCancelled = AcpHandoffCancelledSchema;
