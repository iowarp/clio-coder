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
 * pre-layer selection recorded through the ledger. `structural-v2` is the
 * rung composition under measurement; it becomes the default only once its
 * ablation and ordering tables are recorded.
 */

import type { WorkingSetSettings } from "../../../core/defaults.js";

export type { WorkingSetPolicyId, WorkingSetProfileId, WorkingSetSettings } from "../../../core/defaults.js";

export const DEFAULT_WORKING_SET_SETTINGS: WorkingSetSettings = {
	enabled: true,
	policy: "structural-v1",
	// The protection profile: `default` adds nothing to the absolute predicates.
	// `data-analysis` and `web-design` pin what those kinds of work come back
	// to; see policies/profiles.ts.
	profile: "default",
	target: 0.6,
	protectLastTurns: 6,
	// Real ledgers put most of a session inside one to four user turns, with up
	// to sixty tool results in a single turn. Six protected turns then cover the
	// whole session and the summary stage does all the work. Eight steps keep
	// the model's immediate working context (the last few reads and the edit
	// they informed) while everything older in the same turn stays evictable.
	protectLastSteps: 8,
	// The procedural floor sweep found marker break-even near 50 tokens. A zero
	// floor saved only 0.167 summaries at 64k and none at 128k while reducing
	// covered retention by 0.0076 and 0.0237. Keep 200 as the churn guard.
	minEvictableTokens: 200,
	// A checkpoint runs before every model request, and each applied event
	// cold-starts the prefix cache from the earliest evicted position. The band
	// makes a second event wait until the projection has grown by this share
	// of the window; the replay sweep over 0, 0.05, 0.1 and 0.15 is recorded in
	// the commit that introduced it.
	rearmFraction: 0.1,
};
