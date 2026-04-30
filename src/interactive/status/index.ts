export type { StatusController, StatusControllerDeps } from "./controller.js";
export { createStatusController } from "./controller.js";
export { type ReduceContext, reduceStatus, type StatusInputEvent } from "./state-machine.js";
export { type BuildSummaryInput, buildSummary, emptySummary } from "./summary.js";
export {
	type AgentStatus,
	type AgentStatusChangedPayload,
	type AgentStatusEvent,
	INITIAL_STATUS,
	type StatusPhase,
	type TurnStopReason,
	type TurnSummary,
	type WatchdogTier,
} from "./types.js";
export { formatStatusElapsed, resolveFooterVerb, resolveInlineVerb, spinnerFrame, type VerbRender } from "./verbs.js";
export { computeWatchdogTier, stuckThresholdMs, TIER_THRESHOLDS_MS } from "./watchdog.js";
