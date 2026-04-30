import { extractReasoningTokens } from "../../domains/session/context-accounting.js";
import type { AgentMessage } from "../../engine/types.js";
import type { TurnStopReason, TurnSummary, WatchdogTier } from "./types.js";

export interface BuildSummaryInput {
	startedAt: number;
	endedAt: number;
	modelId: string;
	endpointId: string;
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

export function buildSummary(input: BuildSummaryInput): TurnSummary {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let reasoningTokens = 0;
	let hadReasoningTokens = false;
	let toolCount = 0;
	let toolErrorCount = 0;
	let stopReason: TurnStopReason = input.cancelled ? "cancelled" : "stop";

	for (const message of input.messages) {
		if (message.role === "assistant") {
			const usage = (message as { usage?: UsageLike }).usage;
			if (usage) {
				inputTokens += finite(usage.input);
				outputTokens += finite(usage.output);
				cacheReadTokens += finite(usage.cacheRead);
				cacheWriteTokens += finite(usage.cacheWrite);
				const reasoning = extractReasoningTokens(usage);
				if (reasoning !== null) {
					reasoningTokens += reasoning;
					hadReasoningTokens = true;
				}
			}
			const reason = assistantStopReason((message as { stopReason?: unknown }).stopReason);
			if (reason && reason !== "stop") stopReason = reason;
		}
		if (message.role === "toolResult") {
			toolCount += 1;
			if ((message as { isError?: boolean }).isError === true) toolErrorCount += 1;
		}
	}

	const summary: TurnSummary = {
		elapsedMs: Math.max(0, input.endedAt - input.startedAt),
		modelId: input.modelId,
		endpointId: input.endpointId,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		toolCount,
		toolErrorCount,
		stopReason,
		watchdogPeak: input.watchdogPeak,
		truncated: input.truncated === true,
	};
	if (hadReasoningTokens) summary.reasoningTokens = reasoningTokens;
	return summary;
}

export function emptySummary(input: {
	startedAt: number;
	endedAt: number;
	modelId: string;
	endpointId: string;
	watchdogPeak: WatchdogTier;
	stopReason?: TurnStopReason;
	truncated?: boolean;
}): TurnSummary {
	return {
		elapsedMs: Math.max(0, input.endedAt - input.startedAt),
		modelId: input.modelId,
		endpointId: input.endpointId,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		toolCount: 0,
		toolErrorCount: 0,
		stopReason: input.stopReason ?? "stop",
		watchdogPeak: input.watchdogPeak,
		truncated: input.truncated === true,
	};
}
