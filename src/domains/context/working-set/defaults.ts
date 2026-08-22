/**
 * Working-set settings: user-visible defaults. The structural type lives in
 * `src/core/defaults.ts` beside the rest of the settings tree so core stays
 * free of a backward domain dependency; this module pairs it with the value
 * the DEFAULT_SETTINGS tree and the engine read at runtime.
 *
 * `structural-v1` is the default: typed path-keyed rules first, the age rule
 * last and batched to `target`. On the reproducible 24-trace procedural grid,
 * it meets the recorded default rule at 32k, 64k, and 128k: retention is no
 * lower than `age-horizon`, precision is higher than random, and the target
 * stop remains active above 32k. `age-horizon` stays available as the exact
 * pre-layer selection recorded through the ledger.
 */

import type { WorkingSetSettings } from "../../../core/defaults.js";

export type { WorkingSetPolicyId, WorkingSetSettings } from "../../../core/defaults.js";

export const DEFAULT_WORKING_SET_SETTINGS: WorkingSetSettings = {
	enabled: true,
	policy: "structural-v1",
	target: 0.6,
	protectLastTurns: 6,
	// The procedural floor sweep found marker break-even near 50 tokens. A zero
	// floor saved only 0.167 summaries at 64k and none at 128k while reducing
	// covered retention by 0.0076 and 0.0237. Keep 200 as the churn guard.
	minEvictableTokens: 200,
};
