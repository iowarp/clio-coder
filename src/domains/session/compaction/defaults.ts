/**
 * Compaction settings: user-visible defaults (Phase 12 slice 12c).
 *
 * The public settings block documented in the plan is intentionally tiny:
 * `threshold` (fraction of contextWindow at which auto-compaction fires),
 * `auto` (master switch), and two optional overrides: `model` and
 * `systemPrompt`. The structural type lives in `src/core/defaults.ts`
 * alongside the rest of the settings tree so core code stays free of a
 * backward domain dependency; this module pairs that type with the value
 * the DEFAULT_SETTINGS tree and the chat-loop read at runtime.
 */

import type { CompactionSettings } from "../../../core/defaults.js";

export type { CompactionSettings } from "../../../core/defaults.js";

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	threshold: 0.8,
	auto: true,
};

/**
 * Tokens held in reserve for the summary response. Ported from
 * pi-coding-agent's `DEFAULT_COMPACTION_SETTINGS.reserveTokens`; kept as an
 * engine-level constant so adjusting it later does not require a settings
 * migration.
 */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * Minimum tokens of recent context the cut-point must keep. The estimator
 * walks backwards until it has accumulated at least this many tokens, then
 * cuts at the nearest valid boundary.
 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
