import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
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
	estimated?: boolean;
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
			toolCount: tally.toolCount + 1,
			toolErrorCount: tally.toolErrorCount + ((message as { isError?: boolean }).isError === true ? 1 : 0),
		};
	}
	if (message.role !== "assistant") return tally;
	const usage = (message as { usage?: UsageLike }).usage;
	const record = message as unknown as Record<string, unknown>;
	const next: RunTally = {
		...tally,
		responseModelIdObservation: responseModelIdObservationFromRecord(record, "not-observed"),
		inputTokens: tally.inputTokens + (usage ? finite(usage.input) : 0),
		outputTokens: tally.outputTokens + (usage ? finite(usage.output) : 0),
		cacheReadTokens: tally.cacheReadTokens + (usage ? finite(usage.cacheRead) : 0),
		cacheWriteTokens: tally.cacheWriteTokens + (usage ? finite(usage.cacheWrite) : 0),
	};
	// Interrupted turns carry Clio's own estimated usage object. It retains the
	// completed-record shape, including `reasoning: 0`, but that zero is not a
	// provider attestation and must not suppress the thinking-text fallback.
	const reasoning = usage && usage.estimated !== true ? extractReasoningTokens(usage) : null;
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
		// A chars/4 estimate over displayed thinking text can outrun what the
		// provider says the call generated (summarized reasoning, a rail that
		// re-renders the same block). Reported output is the ceiling for anything
		// inferred: reasoning is part of that output, never more than it. No
		// clamp exists upstream in the adapters, so it lives here, once.
		const reportedOutput =
			usage && typeof usage.output === "number" && Number.isFinite(usage.output) ? Math.max(0, usage.output) : null;
		next.reasoningTokens += reportedOutput === null ? estimated : Math.min(estimated, reportedOutput);
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
		responseModelIdObservation: tally.responseModelIdObservation,
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
