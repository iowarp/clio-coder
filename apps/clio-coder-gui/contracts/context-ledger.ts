import { AcpContextLedgerSchema, AcpContextCapability as ContextCapability } from "./wire.js";

export { ContextCapability };

import type { Static } from "typebox";

// `_clio-coder/context/ledger`: the terminal's /context window view, read and never recomputed.
// The agent bounds groups at 32 and handbook files at 16; these schemas restate that.

export const ContextLedger = AcpContextLedgerSchema;
export type ContextLedger = Static<typeof ContextLedger>;
