/**
 * The shipped structural compositions.
 *
 * `structural-v1` is the recorded previous default: the five path-keyed
 * rungs, then closed-step thinking, then age under pressure. `structural-v2`
 * is the master composition: the same head, then `offloaded_body` (the one
 * candidate rung whose own replay row earned its place), the same tail, and
 * the churn pin. The rung bodies live in `rungs.ts`; the composer that runs
 * them, applies protection and keeps the headroom lives in `compose.ts`.
 * Both ids resolve through `resolveWorkingSetPolicy`.
 */

import { composePolicy, STRUCTURAL_V1_RUNGS, STRUCTURAL_V2_RUNGS } from "./compose.js";

export const structuralPolicy = composePolicy("structural-v1", STRUCTURAL_V1_RUNGS);
export const structuralV2Policy = composePolicy("structural-v2", STRUCTURAL_V2_RUNGS);
