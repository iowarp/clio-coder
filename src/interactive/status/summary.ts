import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import type { AgentMessage } from "../../engine/types.js";
import {
	classifyTurnEnding,
	endedOnCancelledInterview,
	sumRunUsage,
} from "../../session-control/chat-loop-messages.js";
import type {
	RunTally,
	TurnFailureFacts,
	TurnStopReason,
	TurnSummary,
	WatchdogTier,
} from "../../session-control/status-types.js";
import { readProviderFailureRoute } from "../renderers/provider-error.js";

export interface BuildSummaryInput {
	startedAt: number;
	endedAt: number;
	modelId: string;
	targetId: string;
	messages: ReadonlyArray<AgentMessage>;
	watchdogPeak: WatchdogTier;
	cancelled: boolean;
	truncated?: boolean;
}

function assistantStopReason(value: unknown): TurnStopReason | null {
	if (
		value === "stop" ||
		value === "length" ||
		value === "toolUse" ||
		value === "error" ||
		value === "aborted" ||
		value === "cancelled"
	) {
		return value;
	}
	return null;
}

export function emptyRunTally(): RunTally {
	return {
		settledMessages: 0,
		toolCount: 0,
		toolErrorCount: 0,
		responseModelIdObservation: { state: "not-observed" },
	};
}

/**
 * Fold one settled message into a run tally.
 *
 * `buildSummary` and the live accumulator that survives a cancel both go
 * through here, so the two paths cannot drift into reporting a turn
 * differently depending on how it ended.
 */
/** A message's failure class when it ended the call in an error; a later call in the run replaces it. */
export function turnFailureFacts(message: unknown): TurnFailureFacts | undefined {
	const record = message as { stopReason?: unknown; failureRoute?: unknown; errorMessage?: unknown };
	if (record.stopReason !== "error") return undefined;
	const route = readProviderFailureRoute(record.failureRoute);
	if (route === null) return undefined;
	const { url: _endpoint, ...facts } = route;
	// A call Clio never sent failed on Clio's own refusal, whose text is Clio's words rather than a provider's.
	return route.stage === "admission" && typeof record.errorMessage === "string" && record.errorMessage.length > 0
		? { ...facts, reason: record.errorMessage }
		: facts;
}

export function foldMessageIntoRunTally(tally: RunTally, message: AgentMessage): RunTally {
	if (message.role === "toolResult") {
		return {
			...tally,
			settledMessages: tally.settledMessages + 1,
			toolCount: tally.toolCount + 1,
			toolErrorCount: tally.toolErrorCount + ((message as { isError?: boolean }).isError === true ? 1 : 0),
		};
	}
	if (message.role !== "assistant") return tally;
	const folded = sumRunUsage([message]);
	const failure = turnFailureFacts(message);
	const { failure: _earlier, ...unfailed } = tally;
	return {
		...unfailed,
		...(failure !== undefined ? { failure } : {}),
		settledMessages: tally.settledMessages + 1,
		responseModelIdObservation: folded.hadUsage
			? folded.lastResponseModelIdObservation
			: responseModelIdObservationFromRecord(message as unknown as Record<string, unknown>, "not-observed"),
	};
}

export interface SummaryFromTallyInput {
	startedAt: number;
	endedAt: number;
	modelId: string;
	targetId: string;
	watchdogPeak: WatchdogTier;
	stopReason: TurnStopReason;
	stopDetail?: string;
	truncated?: boolean;
}

export function summaryFromRunTally(tally: RunTally, input: SummaryFromTallyInput): TurnSummary {
	return {
		elapsedMs: Math.max(0, input.endedAt - input.startedAt),
		modelId: input.modelId,
		targetId: input.targetId,
		toolCount: tally.toolCount,
		toolErrorCount: tally.toolErrorCount,
		stopReason: input.stopReason,
		...(input.stopDetail !== undefined ? { stopDetail: input.stopDetail } : {}),
		watchdogPeak: input.watchdogPeak,
		truncated: input.truncated === true,
		responseModelIdObservation: tally.responseModelIdObservation,
		...(input.stopReason === "error" && tally.failure !== undefined ? { failure: tally.failure } : {}),
	};
}

export function buildSummary(input: BuildSummaryInput): TurnSummary {
	let stopReason: TurnStopReason = input.cancelled ? "cancelled" : "stop";
	let tally = emptyRunTally();
	for (const message of input.messages) {
		tally = foldMessageIntoRunTally(tally, message);
		if (message.role === "assistant") {
			const reason = assistantStopReason((message as { stopReason?: unknown }).stopReason);
			if (reason && reason !== "stop") {
				stopReason =
					reason === "aborted" && recordAbortSource(message) === "tool_argument_generation" ? "generation_guard" : reason;
			}
		}
	}
	if ((stopReason === "stop" || stopReason === "toolUse") && classifyTurnEnding(input.messages)?.kind === "no_answer")
		stopReason = "no_answer";
	if (stopReason === "stop" || stopReason === "toolUse") {
		if (endedOnCancelledInterview(input.messages)) stopReason = "cancelled";
	}
	return summaryFromRunTally(tally, {
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		modelId: input.modelId,
		targetId: input.targetId,
		watchdogPeak: input.watchdogPeak,
		stopReason,
		...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
	});
}

function recordAbortSource(message: AgentMessage): unknown {
	return (message as unknown as { clioCoderAbortReason?: unknown }).clioCoderAbortReason;
}
