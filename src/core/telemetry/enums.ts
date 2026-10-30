import type { Static, TEnum } from "typebox";
import { Type } from "typebox";

export function vocabulary<const T extends readonly string[]>(values: T): TEnum<T[number][]> {
	return Type.Enum<T[number][]>([...values]);
}

export const CallLabel = vocabulary([
	"main",
	"worker",
	"compaction",
	"memory",
	"system-one",
	"prewarm",
	"btw",
	"handoff",
	"helper",
	"safety-judge",
]);
export type CallLabel = Static<typeof CallLabel>;
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
	"internal",
]);
export type FailureCause = Static<typeof FailureCause>;
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
/** Who changed the settings: the watcher's reload of a file write, or the in-process surface that made the edit (#434). */
export const ConfigChangeSource = vocabulary([
	"file",
	"settings-ui",
	"cli",
	"session-override",
	"slash-command",
	"acp",
	"unattributed",
]);
export type RunBoundKind = Static<typeof RunBoundKind>;
