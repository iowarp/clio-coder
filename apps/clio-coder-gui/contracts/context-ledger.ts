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

export const WireContextLedger = AcpContextLedgerSchema;
export type WireContextLedger = Static<typeof WireContextLedger>;

const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 256 });
const nullable = Type.Union([text, Type.Null()]);
/**
 * Every count the ledger carries, worded on the server by the canonical renderer (#434 §11.3); null where the
 * ledger reports none. The client draws these and never formats a count. `meter` is the compact pair the top bar
 * shows, null when the window size is not reported.
 */
export const ContextLedgerDisplay = Type.Object(
	{
		used: text,
		window: nullable,
		free: nullable,
		reserve: text,
		percent: nullable,
		meter: Type.Union([Type.Object({ used: text, window: text }, closed), Type.Null()]),
		slotsTotal: nullable,
		groups: Type.Array(Type.Object({ tokens: text, share: nullable }, closed), { maxItems: 32 }),
		lastCompaction: Type.Union([Type.Object({ before: text, after: text }, closed), Type.Null()]),
		cache: Type.Union([
			Type.Object({ cacheRead: nullable, cacheWrite: nullable, uncachedInput: nullable }, closed),
			Type.Null(),
		]),
	},
	closed,
);
export const ContextLedger = Type.Object(
	{ ...AcpContextLedgerSchema.properties, display: ContextLedgerDisplay },
	closed,
);
export type ContextLedger = Static<typeof ContextLedger>;
