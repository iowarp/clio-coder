import { estimateReasoningTextTokens, extractReasoningTokens } from "../../domains/session/context-accounting.js";
import type { AgentMessage } from "../../engine/types.js";
import type { ReasoningTokenProvenance, RunTally, TurnStopReason, TurnSummary, WatchdogTier } from "./types.js";

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
}

function assistantThinkingText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "thinking"; thinking: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "thinking" &&
				typeof (block as { thinking?: unknown }).thinking === "string",
		)
		.map((block) => block.thinking)
		.join("");
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
		reasoningTokens: 0,
		hadProviderReasoning: false,
		hadEstimatedReasoning: false,
		toolCount: 0,
		toolErrorCount: 0,
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
			toolCount: tally.toolCount + 1,
			toolErrorCount: tally.toolErrorCount + ((message as { isError?: boolean }).isError === true ? 1 : 0),
		};
	}
	if (message.role !== "assistant") return tally;
	const usage = (message as { usage?: UsageLike }).usage;
	const next: RunTally = {
		...tally,
		inputTokens: tally.inputTokens + (usage ? finite(usage.input) : 0),
		outputTokens: tally.outputTokens + (usage ? finite(usage.output) : 0),
		cacheReadTokens: tally.cacheReadTokens + (usage ? finite(usage.cacheRead) : 0),
		cacheWriteTokens: tally.cacheWriteTokens + (usage ? finite(usage.cacheWrite) : 0),
	};
	const reasoning = usage ? extractReasoningTokens(usage) : null;
	if (reasoning !== null) {
		next.reasoningTokens += reasoning;
		next.hadProviderReasoning = true;
		return next;
	}
	// Some providers emit thinking blocks without a usage object. Keep the
	// fallback explicitly estimated so a run containing both shapes is
	// reported as mixed rather than silently dropping the unreported block.
	const estimated = estimateReasoningTextTokens(assistantThinkingText(message));
	if (estimated !== null) {
		next.reasoningTokens += estimated;
		next.hadEstimatedReasoning = true;
	}
	return next;
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
	const summary: TurnSummary = {
		elapsedMs: Math.max(0, input.endedAt - input.startedAt),
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
	};
	if (tally.hadProviderReasoning || tally.hadEstimatedReasoning) {
		summary.reasoningTokens = tally.reasoningTokens;
		const provenance: ReasoningTokenProvenance =
			tally.hadProviderReasoning && tally.hadEstimatedReasoning
				? "mixed"
				: tally.hadProviderReasoning
					? "provider"
					: "estimated";
		summary.reasoningTokenProvenance = provenance;
	}
	return summary;
}

export function buildSummary(input: BuildSummaryInput): TurnSummary {
	let stopReason: TurnStopReason = input.cancelled ? "cancelled" : "stop";
	let tally = emptyRunTally();
	for (const message of input.messages) {
		tally = foldMessageIntoRunTally(tally, message);
		if (message.role === "assistant") {
			const reason = assistantStopReason((message as { stopReason?: unknown }).stopReason);
			if (reason && reason !== "stop") stopReason = reason;
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
