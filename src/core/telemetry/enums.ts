import type { Static, TEnum } from "typebox";
import { Type } from "typebox";
import { RUN_OUTCOME_CODES, RUN_OUTCOMES } from "./run-vocabulary.js";

export function vocabulary<const T extends readonly string[]>(values: T): TEnum<T[number][]> {
	return Type.Enum<T[number][]>([...values]);
}

/**
 * The role of the agent an event acts for. `main` is a session's own agent, `coordinator` a fleet root driving its
 * steps, `worker` a dispatched run; the rest are the side agents a session or process runs beside them (#434).
 */
export const AgentRole = vocabulary([
	"main",
	"coordinator",
	"worker",
	"compaction",
	"memory",
	"system-one",
	"safety-judge",
	"prewarm",
	"btw",
	"handoff",
	"helper",
]);
export type AgentRole = Static<typeof AgentRole>;
/**
 * never_sent carries no usage. sent_unsettled usage is a lower bound: counts the provider reported before the
 * response ended are measured, the rest unknown, and folds mark its sums partial. settled_no_usage is a terminal
 * response without usage; settled is a terminal response with usage (#434).
 */
export const Disposition = vocabulary(["never_sent", "sent_unsettled", "settled_no_usage", "settled"]);
export type Disposition = Static<typeof Disposition>;
export const FailureCause = vocabulary([
	"budget_wait_aborted",
	"admission_refused",
	"auth_rejected",
	"auth_refresh_failed",
	"transport_connect",
	"transport_dropped",
	"provider_4xx",
	"provider_5xx",
	"rate_limited",
	"usage_limit_reached",
	"tool_choice_rejected",
	"context_overflow",
	"stall_pre_invocation",
	"stall_first_token",
	"stall_mid_stream",
	"operator_cancel",
	"parent_cancel",
	"route_moved",
	"triage_stop",
	"autonomy_stop",
	"job_clock",
	"repetition",
	"generation_guard",
	"turn_timeout",
	"output_cap",
	"loop_guard",
	// The post-tool context guard ended the turn cleanly: after compaction the tool results still overflow the window.
	"oversized_tool_result",
	"shutdown",
	"internal",
]);
export type FailureCause = Static<typeof FailureCause>;
/**
 * Why a turn that stopped normally answered nothing (`classifyTurnEnding`): a call the model only wrote out as text or
 * into its reasoning, a reply that only announced one, reasoning with no reply, or nothing at all (bt-session-res J1).
 */
export const TurnNoAnswerCause = vocabulary([
	"tool_call_in_reasoning",
	"tool_call_as_text",
	"tool_call_announced",
	"reasoning_only",
	"empty",
]);
export type TurnNoAnswerCause = Static<typeof TurnNoAnswerCause>;
export const StopReason = vocabulary(["stop", "toolUse", "length", "error", "aborted", "unknown"]);
export const RoundKind = vocabulary(["normal", "text-only", "required", "tools-removed", "unknown"]);
export const TransportKind = vocabulary(["websocket", "sse", "http", "local", "subprocess", "unknown"]);
export const Tier = vocabulary(["accountability", "operational", "research"]);
export type Tier = Static<typeof Tier>;
export const ContentClass = vocabulary(["content-free", "structural", "content-bearing"]);
export type ContentClass = Static<typeof ContentClass>;
/** How the worker loop ended; the host's verdict on its result stays in outcome and outcomeCode (#425, #434). */
export const RunTerminalReason = vocabulary([
	"completed",
	"cancelled_by_parent",
	"cancelled_by_operator",
	"cancelled_by_peer",
	"preempted",
	"bound_reached",
	"final_output_missing_no_repair",
	"contract_exhausted_after_repair",
	"channel_failure",
	"spawn_error",
	"stalled",
	"denied_by_policy",
	"worker_failed",
]);
export type RunTerminalReason = Static<typeof RunTerminalReason>;
export const RunBoundKind = vocabulary(["turns", "tokens", "cost", "time", "tools"]);
/** The host's verdict on a finished run, beside how its loop ended (#434). */
export const RunOutcome = vocabulary(RUN_OUTCOMES);
export type RunOutcome = Static<typeof RunOutcome>;
export const RunOutcomeCode = vocabulary(RUN_OUTCOME_CODES);
export type RunOutcomeCode = Static<typeof RunOutcomeCode>;
/**
 * Who changed the settings: the watcher's reload of a file write, or the in-process surface that made the edit. Each
 * value has a seam that writes it; a surface that writes settings names itself (#434, C3).
 */
export const ConfigChangeSource = vocabulary(["file", "settings-ui", "slash-command", "keybinding", "acp", "gui"]);
/** The layer a settings change landed in (#434). */
export const ConfigChangeScope = vocabulary(["session", "project", "user"]);
export type RunBoundKind = Static<typeof RunBoundKind>;
/**
 * A non-currency unit an economics quantity or a quota window counts in (token economy S1). A currency amount is named
 * by its ISO 4217 code instead (`EconomyUnitSchema`). `percent` is a provider's opaque percentage with no native unit
 * behind it, and `unknown` a unit nobody reported; neither is additive.
 */
export const NATIVE_UNITS = [
	"nano-aiu",
	"premium-requests",
	"tokens",
	"requests",
	"compute-hours",
	"provider-credits",
	"percent",
	"unknown",
] as const;
export const NativeUnit = vocabulary(NATIVE_UNITS);
export type NativeUnit = Static<typeof NativeUnit>;
/** How a funding scheme became known: the signed-in provider reported it, the user declared it, or neither. */
export const FundingSchemeSource = vocabulary(["detected", "declared", "unknown"]);
export type FundingSchemeSource = Static<typeof FundingSchemeSource>;
/** What kind of funding pays a call; a hint for display and grouping, never a price or a payer. */
export const FundingSchemeKind = vocabulary([
	"subscription",
	"seat",
	"pay-per-token",
	"prepaid",
	"grant",
	"free-tier",
	"local",
	"unknown",
]);
export type FundingSchemeKind = Static<typeof FundingSchemeKind>;
/** Who pays a pool's charges: the user, their organization, a sponsor, nobody (a free or local route), or unknown. */
export const PayerKind = vocabulary(["personal", "organization", "sponsor", "none", "unknown"]);
export type PayerKind = Static<typeof PayerKind>;
/** The billing period a pool's fee or allowance renews on; `one-time` for a grant or a prepaid purchase. */
export const FundingPeriodKind = vocabulary(["day", "week", "month", "year", "one-time", "none", "unknown"]);
export type FundingPeriodKind = Static<typeof FundingPeriodKind>;
