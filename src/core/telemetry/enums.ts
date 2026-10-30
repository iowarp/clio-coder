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
export const StopReason = vocabulary(["stop", "toolUse", "length", "error", "aborted"]);
export const RoundKind = vocabulary(["normal", "text-only", "required", "tools-removed"]);
export const TransportKind = vocabulary(["websocket", "sse", "http", "local", "subprocess", "unknown"]);
export const Tier = vocabulary(["accountability", "operational", "research"]);
export type Tier = Static<typeof Tier>;
export const ContentClass = vocabulary(["content-free", "structural", "content-bearing"]);
export type ContentClass = Static<typeof ContentClass>;
export const RunTerminalReason = vocabulary([
	"completed",
	"cancelled_by_parent",
	"cancelled_by_operator",
	"bound_reached",
	"final_output_missing_no_repair",
	"contract_exhausted_after_repair",
	"channel_failure",
	"spawn_error",
]);
