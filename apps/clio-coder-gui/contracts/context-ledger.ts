import { Type } from "typebox";
import { AcpContextCapability, AcpContextLedgerSchema } from "./wire.js";

// Additive core status and invocation fields; older peers keep their ledger-only capability.
export const ContextCapability = Type.Object(
	{
		...AcpContextCapability.properties,
		status: Type.Optional(Type.String()),
		activity: Type.Optional(Type.Literal("context.activity")),
		invoke: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

import type { Static } from "typebox";

// `_clio-coder/context/ledger`: the terminal's /context window view, read and never recomputed.
// The agent bounds groups at 32 and handbook files at 16; these schemas restate that.

export const ContextLedger = AcpContextLedgerSchema;
export type ContextLedger = Static<typeof ContextLedger>;
