/**
 * Token estimation for session entries (Phase 12 slice 12c).
 *
 * Ports pi-coding-agent's chars/4 heuristic verbatim (reference:
 * pi-mono/packages/coding-agent/src/core/compaction/compaction.ts:232
 * `estimateTokens`). Pure functions, no I/O.
 *
 * Rationale for the heuristic (plan §3):
 *   - Conservative by design: over-estimating trips compaction earlier,
 *     never later. Missing a trigger and hitting provider overflow is
 *     expensive; running a compaction on 80k when actual was 95k is cheap.
 *   - pi-coding-agent ships it at scale, so we adopt the
 *     known ceiling rather than introduce a new numeric contract.
 *   - Exact per-provider counts (Anthropic /count_tokens, tiktoken) are
 *     parked. The `TokenEstimator` interface below keeps them a drop-in
 *     swap for a later phase.
 */

import type { Usage } from "../../../engine/types.js";
import { ceilChars, contentChars, estimateAgentMessageTokens } from "../context-accounting.js";
import type {
	BashExecutionEntry,
	BranchSummaryEntry,
	CompactionSummaryEntry,
	CustomEntry,
	MessageEntry,
	SessionEntry,
} from "../entries.js";

/** Contract future alternate estimators must satisfy. */
export interface TokenEstimator {
	estimateEntry(entry: SessionEntry): number;
	calculateContextTokens(entries: ReadonlyArray<SessionEntry>, lastUsage?: Usage): number;
}

function estimateMessage(entry: MessageEntry): number {
	return estimateAgentMessageTokens(entry);
}

function estimateBashExecution(entry: BashExecutionEntry): number {
	return ceilChars(entry.command.length + entry.output.length);
}

function estimateCustom(entry: CustomEntry): number {
	if (entry.data === undefined) return 0;
	return ceilChars(contentChars(entry.data));
}

function estimateSummary(entry: BranchSummaryEntry | CompactionSummaryEntry): number {
	return ceilChars(entry.summary.length);
}

/**
 * Estimate the token load of a single session entry. Non-context-bearing
 * kinds (modelChange, thinkingLevelChange, fileEntry, sessionInfo,
 * label, protectedArtifact, taskLedger) return 0 so they never distort the
 * context budget.
 */
export function estimateTokens(entry: SessionEntry): number {
	switch (entry.kind) {
		case "message":
			return estimateMessage(entry);
		case "bashExecution":
			return estimateBashExecution(entry);
		case "custom":
			return estimateCustom(entry);
		case "skillActivation":
			return ceilChars(JSON.stringify(entry.activation).length);
		case "branchSummary":
		case "compactionSummary":
			return estimateSummary(entry);
		case "modelChange":
		case "thinkingLevelChange":
		case "fileEntry":
		case "sessionInfo":
		case "label":
		case "protectedArtifact":
		case "taskLedger":
			return 0;
	}
}

function usageTotalTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function extractUsage(payload: unknown): Usage | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as { usage?: unknown; stopReason?: unknown; contextUsageInvalidated?: unknown };
	if (p.contextUsageInvalidated === true) return undefined;
	if (p.stopReason === "aborted" || p.stopReason === "error") return undefined;
	const u = p.usage;
	if (!u || typeof u !== "object") return undefined;
	const usage = u as Partial<Usage>;
	if (typeof usage.input !== "number" || typeof usage.output !== "number") return undefined;
	return usage as Usage;
}

/**
 * Walk entries from newest to oldest, returning the first assistant message
 * whose payload carries a valid usage block. Aborted/error assistant turns
 * are skipped because their usage is not meaningful for context accounting.
 */
export function getLastAssistantUsage(entries: ReadonlyArray<SessionEntry>): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.kind !== "message" || entry?.role !== "assistant") continue;
		const usage = extractUsage(entry.payload);
		if (usage) return usage;
	}
	return undefined;
}

function findLastAssistantUsageIndex(entries: ReadonlyArray<SessionEntry>): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.kind !== "message" || entry?.role !== "assistant") continue;
		if (extractUsage(entry.payload)) return i;
	}
	return -1;
}

/**
 * Total context tokens for the supplied entry list. When `lastUsage` is
 * provided (or derivable from the entries), uses its totalTokens as the
 * anchor and only estimates the entries that followed it. This matches
 * pi-coding-agent's `estimateContextTokens` behavior and keeps the number
 * accurate for sessions whose most recent assistant turn carried real
 * provider usage data.
 */
export function calculateContextTokens(entries: ReadonlyArray<SessionEntry>, lastUsage?: Usage): number {
	const usage = lastUsage ?? getLastAssistantUsage(entries);
	if (usage) {
		const anchorTokens = usageTotalTokens(usage);
		const anchorIndex = findLastAssistantUsageIndex(entries);
		let trailing = 0;
		for (let i = anchorIndex + 1; i < entries.length; i++) {
			const entry = entries[i];
			if (entry) trailing += estimateTokens(entry);
		}
		return anchorTokens + trailing;
	}
	let total = 0;
	for (const entry of entries) total += estimateTokens(entry);
	return total;
}
