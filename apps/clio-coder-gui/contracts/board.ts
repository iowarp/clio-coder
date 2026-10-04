import {
	AcpDecisionSupersededSchema,
	AcpMemoryProposedSchema,
	AcpSessionBoardSchema,
	AcpBoardCapability as BoardCapability,
} from "./wire.js";

export { BoardCapability };

import type { Static } from "typebox";
import { Type } from "typebox";

// `_clio-coder/session/board`: the read half of the terminal's /tasks, /decisions and /memory views.
// The agent bounds every list at 100 items and every string at 1 KiB; these schemas restate that.
const closed = { additionalProperties: false };

export const SessionBoard = AcpSessionBoardSchema;
export type SessionBoard = Static<typeof SessionBoard>;

export const DecisionSupersedeRequest = Type.Object(
	{
		interviewId: Type.String({ minLength: 1, maxLength: 256 }),
		key: Type.String({ minLength: 1, maxLength: 1024 }),
		correction: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
	},
	closed,
);
export const DecisionSuperseded = AcpDecisionSupersededSchema;
export type DecisionSuperseded = Static<typeof DecisionSuperseded>;

export const MemoryProposeRequest = Type.Object(
	{
		entryId: Type.String({ minLength: 1, maxLength: 256 }),
		scope: Type.Union([Type.Literal("repo"), Type.Literal("global")]),
		acknowledgeGlobal: Type.Optional(Type.Boolean()),
	},
	closed,
);
export const MemoryProposed = AcpMemoryProposedSchema;
export type MemoryProposed = Static<typeof MemoryProposed>;
