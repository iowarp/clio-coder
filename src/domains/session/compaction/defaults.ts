/**
 * Compaction settings — user-visible defaults (Phase 12 slice 12c).
 *
 * The public settings block documented in the plan is intentionally tiny:
 * `threshold` (fraction of contextWindow at which auto-compaction fires),
 * `auto` (master switch), and two optional overrides — `model` and
 * `systemPrompt`. Everything else lives as engine-level constants here so a
 * later phase can tune the summary budget without reshaping settings.yaml.
 */

export interface CompactionSettings {
	/**
	 * Fraction of the orchestrator's contextWindow at which auto-compaction
	 * fires. 0..1. Slice 12c only uses this to persist the value; the
	 * threshold check itself lands with slice 12d's `shouldCompact`.
	 */
	threshold: number;
	/**
	 * When false, auto-compaction is disabled. Manual `/compact` still runs —
	 * the flag only gates the chat-loop's pre-request trigger in 12d.
	 */
	auto: boolean;
	/**
	 * Optional pattern for the summarization model. Accepts the same syntax
	 * as `provider.scope` (e.g. `openai/gpt-5-mini`). When absent, the engine
	 * falls back to `settings.orchestrator.{provider,model,endpoint}`.
	 */
	model?: string;
	/**
	 * Path to a system-prompt override file. Resolved to text by the caller,
	 * not here — this module is settings-shape only. Absent ⇒ the built-in
	 * prompt in `compact.ts` is used.
	 */
	systemPrompt?: string;
}

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
