/**
 * Working-set settings: user-visible defaults. The structural type lives in
 * `src/core/defaults.ts` beside the rest of the settings tree so core stays
 * free of a backward domain dependency; this module pairs it with the value
 * the DEFAULT_SETTINGS tree and the engine read at runtime.
 *
 * `enabled: true` with `policy: "age-horizon"` is today's selection (every
 * tool-result body and thinking block beyond the protection horizon) recorded
 * as a projection instead of a ledger rewrite. `structural-v1` stays opt-in
 * until replay-lite shows it ahead of `age-horizon`.
 */

import type { WorkingSetSettings } from "../../../core/defaults.js";

export type { WorkingSetPolicyId, WorkingSetSettings } from "../../../core/defaults.js";

export const DEFAULT_WORKING_SET_SETTINGS: WorkingSetSettings = {
	enabled: true,
	policy: "age-horizon",
	target: 0.6,
	protectLastTurns: 6,
	minEvictableTokens: 200,
};
