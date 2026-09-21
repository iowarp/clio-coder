/**
 * Token estimation for session entries.
 *
 * Uses shared context-accounting estimates for messages and character-based
 * estimates for other context-bearing entries. Provider usage anchors measured
 * prefixes when available. These estimates are approximate, not token ceilings.
 * Pure functions, no I/O.
 *
 *   - Exact per-provider counts (Anthropic /count_tokens, tiktoken) are
 *     parked. The `TokenEstimator` interface below keeps them a drop-in
 *     swap for a later phase.
 */

import type { Usage } from "../../../engine/types.js";
import { ceilChars, contentChars, estimateAgentMessageTokens } from "../context-accounting.js";
import { HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE } from "../continuity/operator-request.js";
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
	// Usage invalidation is bookkeeping for token-anchor selection. The replay
	// builder carries it as AgentMessage metadata, but providers never see it in
	// message content, so it cannot change a projected entry's prompt cost. Drop
	// it here so plan-time pricing and the post-event projection use one byte
	// definition even though only the latter has applied the stamp.
	if (entry.role !== "assistant" || !entry.payload || typeof entry.payload !== "object") {
		return estimateAgentMessageTokens(entry);
	}
	const payload = entry.payload as Record<string, unknown>;
	if (!("contextUsageInvalidated" in payload)) return estimateAgentMessageTokens(entry);
	const { contextUsageInvalidated: _stamp, ...promptPayload } = payload;
	return estimateAgentMessageTokens({ ...entry, payload: promptPayload });
}

function estimateBashExecution(entry: BashExecutionEntry): number {
	// `!!` rows are transcript-only and never become provider input, including
	// through a later compaction prompt. Charging their bytes to the model
	// context would make the context meter claim the model can see private output.
	if (entry.excludeFromContext === true) return 0;
	return ceilChars(entry.command.length + entry.output.length);
}

function estimateCustom(entry: CustomEntry): number {
	if (entry.data === undefined) return 0;
	// The reserved operator recovery request is a control record, not model text.
	// Model replay skips it by design (it is never turned into a user turn), so
	// charging its data to the context budget would claim the model can see a
	// record it is never shown.
	if (entry.customType === HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE) return 0;
	return ceilChars(contentChars(entry.data));
}

function estimateSummary(entry: BranchSummaryEntry | CompactionSummaryEntry): number {
	let tokens = ceilChars(entry.summary.length);
	if (entry.kind !== "compactionSummary") return tokens;
	if (entry.userContext) tokens += ceilChars(entry.userContext.text.length + 40) + 4;
	for (const skill of entry.skillContext?.skills ?? []) {
		tokens += ceilChars(skill.requestText.length + 40) + 4;
		tokens += ceilChars(JSON.stringify(skill.activation).length + 32) + 4;
		for (const block of skill.content) tokens += ceilChars(block.text.length) + 4;
	}
	return tokens;
}

/**
 * Estimate the token load of a single session entry. Non-context-bearing
 * kinds (modelChange, thinkingLevelChange, fileEntry, sessionInfo,
 * label, protectedArtifact, taskLedger, decisionLedger, workerRun) return 0 so they never
 * distort the context budget.
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
		case "decisionLedger":
		case "workerRun":
		// Working-set bookkeeping: refs and markers, never bodies. The
		// projection accounts for marker cost on the projected messages.
		case "contextEviction":
		case "contextRecall":
		// Continuity bookkeeping. The transaction chain and the commit payload
		// are never model text, and a carried payload is a copy of facts the
		// projection already holds: charging every copy would price one accepted
		// note three times over three summary cycles. The single rendered note
		// the projection does emit is priced once, by the caller that resolved
		// it, through `continuityNoteTokens` on `calculateContextTokens`.
		case "handoffTransaction":
		case "continuityCommit":
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
/**
 * The continuity note a replay projects, for callers pricing a whole prompt.
 *
 * `tokens` comes from `continuityProjectionTokens`, and `anchorTurnId` is the
 * ledger record that introduced the transaction. Selecting which note gets
 * projected needs session and fork facts a token estimator does not have, so
 * the caller resolves it; a second selection rule here would be free to drift
 * from the fold's.
 */
export interface ContinuityNoteCost {
	tokens: number;
	anchorTurnId: string | null;
}

export function calculateContextTokens(
	entries: ReadonlyArray<SessionEntry>,
	lastUsage?: Usage,
	continuityNote?: ContinuityNoteCost,
): number {
	const usage = lastUsage ?? getLastAssistantUsage(entries);
	const noteTokens = continuityNote?.tokens ?? 0;
	if (usage) {
		const anchorTokens = usageTotalTokens(usage);
		const anchorIndex = findLastAssistantUsageIndex(entries);
		let trailing = 0;
		for (let i = anchorIndex + 1; i < entries.length; i++) {
			const entry = entries[i];
			if (entry) trailing += estimateTokens(entry);
		}
		// The anchor is a real provider prompt count. Once a continuation has run
		// with the note in front of it, that measurement already contains the note,
		// and adding it again would inflate `tokensBefore` a little more on every
		// compaction cycle. Only a note introduced *after* the anchored call is new
		// material. An unlocatable anchor record is treated as new, which
		// over-counts by one note rather than hiding it.
		const introducedAt =
			continuityNote?.anchorTurnId == null
				? -1
				: entries.findIndex((entry) => entry.turnId === continuityNote.anchorTurnId);
		const alreadyMeasured = introducedAt >= 0 && introducedAt <= anchorIndex;
		return anchorTokens + trailing + (alreadyMeasured ? 0 : noteTokens);
	}
	// With no anchor everything is estimated, so the note is always new material.
	let total = noteTokens;
	for (const entry of entries) total += estimateTokens(entry);
	return total;
}
