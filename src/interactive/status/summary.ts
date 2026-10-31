import { messageUsageForAccounting } from "../../core/message-accounting.js";
import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import type { AgentMessage } from "../../engine/types.js";
import { sumRunUsage } from "../../session-control/chat-loop-messages.js";
import type { RunTally, TurnStopReason, TurnSummary, WatchdogTier } from "../../session-control/status-types.js";

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

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	estimated?: boolean;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
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
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
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
	const record = message as unknown as Record<string, unknown>;
	const providerUsage = messageUsageForAccounting(message) as (UsageLike & { callInvoked?: boolean }) | null;
	const estimate = record.estimatedUsage as UsageLike | undefined;
	// This tally is for display; spending reads only the provider's usage (#423, #430).
	const usage =
		providerUsage?.callInvoked === true &&
		record.stopReason === "aborted" &&
		!normalizeTokenUsage(providerUsage as Record<string, unknown>).observed &&
		estimate?.estimated === true
			? estimate
			: providerUsage;
	const folded = sumRunUsage([message], { includeEstimates: true });
	const summary = folded.costSummary ? folded : undefined;
	return {
		...tally,
		...(summary?.estimated || usage?.estimated === true ? { estimated: true } : {}),
		settledMessages: tally.settledMessages + 1,
		responseModelIdObservation:
			summary?.lastResponseModelIdObservation ?? responseModelIdObservationFromRecord(record, "not-observed"),
		inputTokens: tally.inputTokens + (summary?.input ?? (usage ? finite(usage.input) : 0)),
		outputTokens: tally.outputTokens + (summary?.output ?? (usage ? finite(usage.output) : 0)),
		cacheReadTokens: tally.cacheReadTokens + (summary?.cacheRead ?? (usage ? finite(usage.cacheRead) : 0)),
		cacheWriteTokens: tally.cacheWriteTokens + (summary?.cacheWrite ?? (usage ? finite(usage.cacheWrite) : 0)),
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
		...(tally.estimated === true ? { estimated: true } : {}),
		modelId: input.modelId,
		targetId: input.targetId,
		inputTokens: tally.inputTokens,
		outputTokens: tally.outputTokens,
		cacheReadTokens: tally.cacheReadTokens,
		cacheWriteTokens: tally.cacheWriteTokens,
		toolCount: tally.toolCount,
		toolErrorCount: tally.toolErrorCount,
		stopReason: input.stopReason,
		...(input.stopDetail !== undefined ? { stopDetail: input.stopDetail } : {}),
		watchdogPeak: input.watchdogPeak,
		truncated: input.truncated === true,
		responseModelIdObservation: tally.responseModelIdObservation,
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
