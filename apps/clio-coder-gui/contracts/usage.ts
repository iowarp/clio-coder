import { AcpSessionUsageSchema, AcpUsageCapability as UsageCapability } from "./wire.js";

export { UsageCapability };

import type { Static } from "typebox";

// `_clio-coder/usage/read`: the terminal's /usage numbers. Session cost and tokens are Clio Coder's own
// accounting, folded per provider and model; quota is each provider's own report. The agent bounds rows
// at 32, providers at 16, windows at 8 and every string at 256 bytes.

export const SessionUsage = AcpSessionUsageSchema;
export type SessionUsage = Static<typeof SessionUsage>;
