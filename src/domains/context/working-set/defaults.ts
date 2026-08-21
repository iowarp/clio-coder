/**
 * Working-set settings: user-visible defaults. The structural type lives in
 * `src/core/defaults.ts` beside the rest of the settings tree so core stays
 * free of a backward domain dependency; this module pairs it with the value
 * the DEFAULT_SETTINGS tree and the engine read at runtime.
 *
 * `structural-v1` is the default: typed path-keyed rules first, the age
 * rule last and batched to `target`. On 165 Claude Code transcripts it held
 * retention 0.831 against 0.781 for `age-horizon` and 0.779 for random at a
 * 128k budget (benchmarks/results/context-replay/). `age-horizon` stays
 * available as the exact pre-layer selection recorded through the ledger.
 */

import type { WorkingSetSettings } from "../../../core/defaults.js";

export type { WorkingSetPolicyId, WorkingSetSettings } from "../../../core/defaults.js";

export const DEFAULT_WORKING_SET_SETTINGS: WorkingSetSettings = {
	enabled: true,
	policy: "structural-v1",
	target: 0.6,
	protectLastTurns: 6,
	minEvictableTokens: 200,
};
