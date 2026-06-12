/**
 * Cheap pre-stage for compaction: mask the bodies of tool results older than
 * the protected recent-turn horizon. Tool call/result pairing and metadata
 * survive so replay dependencies stay intact; only the observation body is
 * replaced with a short marker telling the model how to re-fetch.
 *
 * The same pass drops thinking blocks from assistant messages older than the
 * horizon. Prior-turn reasoning is replayed by the local engine adapters
 * (lmstudio `<think>` text, ollama `thinking`, llama.cpp `reasoning_content`)
 * and counted by the pressure estimator, yet has no forward value once the
 * turn is past the protected window; the Anthropic API drops it after every
 * turn. No marker replaces it: thinking is model-internal and a marker would
 * spend tokens to say nothing. Recent turns keep their thinking untouched so
 * same-model signature replay still works where it matters.
 *
 * Entries that already carry a `contextCompaction` marker (from any earlier
 * compaction run) are never rewritten again; thinking masking is naturally
 * idempotent (a stripped message has no thinking blocks left) and stamps
 * `mask_thinking` so the ledger records why the reasoning vanished.
 */

import type { MessageEntry, SessionEntry } from "../entries.js";
import { calculateContextTokens } from "./tokens.js";

export interface MaskObservationsResult {
	entries: SessionEntry[];
	changed: boolean;
	tokensBefore: number;
	tokensAfter: number;
	maskedObservations: number;
	maskedThinkingBlocks: number;
	maskedThinkingChars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneEntry(entry: SessionEntry): SessionEntry {
	return structuredClone(entry) as SessionEntry;
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("");
}

function stringifyPreview(value: unknown, limit = 10_000): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
	try {
		const text = JSON.stringify(value);
		if (!text) return "";
		return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
	} catch {
		const text = String(value);
		return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
	}
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return stringifyPreview(result);
	const contentText = textFromContent(result.content);
	if (contentText.length > 0) return contentText;
	if (typeof result.text === "string") return result.text;
	if (typeof result.output === "string") return result.output;
	if (typeof result.message === "string") return result.message;
	return stringifyPreview(result);
}

function extractToolResultPayload(payload: unknown): {
	obj: Record<string, unknown>;
	result: unknown;
	toolName: string;
} {
	const obj = isRecord(payload) ? payload : { result: payload };
	const result = obj.result ?? obj.output ?? obj.out ?? obj.content ?? payload;
	const toolName =
		(typeof obj.toolName === "string" && obj.toolName) ||
		(typeof obj.name === "string" && obj.name) ||
		(typeof obj.tool === "string" && obj.tool) ||
		"tool";
	return { obj, result, toolName };
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	return text.split(/\r\n|\r|\n/).length;
}

function observationMarker(toolName: string, text: string): string {
	const preview = text.trim().replace(/\s+/g, " ").slice(0, 160);
	const suffix = preview.length > 0 ? ` Preview: ${preview}` : "";
	return `[Observation masked: ${toolName} output was ${lineCount(text)} lines, ${text.length} chars - contents masked to save context. Re-run the tool for current content.]${suffix}`;
}

function maskedToolResult(original: unknown, marker: string): Record<string, unknown> {
	const details = isRecord(original) && isRecord(original.details) ? { ...original.details } : {};
	return {
		content: [{ type: "text", text: marker }],
		details: {
			...details,
			contextCompaction: { stage: "mask_observations", at: new Date().toISOString() },
		},
	};
}

function alreadyCompacted(payload: unknown): boolean {
	if (!isRecord(payload)) return false;
	if (isRecord(payload.contextCompaction)) return true;
	const summary = payload.resultSummary;
	if (isRecord(summary) && isRecord(summary.contextCompaction)) return true;
	const result = payload.result ?? payload.output ?? payload.out;
	if (isRecord(result) && isRecord(result.details) && isRecord(result.details.contextCompaction)) return true;
	return false;
}

function maskObservation(entry: MessageEntry): MessageEntry {
	const next = cloneEntry(entry) as MessageEntry;
	const { obj, result, toolName } = extractToolResultPayload(next.payload);
	const text = resultText(result);
	const marker = observationMarker(toolName, text);
	next.payload = {
		...obj,
		result: maskedToolResult(result, marker),
		output: undefined,
		out: undefined,
		content: undefined,
		resultSummary: {
			...(isRecord(obj.resultSummary) ? obj.resultSummary : {}),
			bytes: 0,
			truncated: true,
			contextCompaction: {
				stage: "mask_observations",
				originalChars: text.length,
				originalLines: lineCount(text),
				at: new Date().toISOString(),
			},
		},
	};
	return next;
}

interface MaskedThinking {
	entry: MessageEntry;
	blocks: number;
	chars: number;
}

/**
 * Strip thinking content from a stale assistant message. Returns null when
 * the message carries no thinking (the no-op case, which keeps `changed`
 * honest and makes reruns naturally idempotent). Handles both shapes the
 * session ledger contains: `content` blocks of type `thinking` and the
 * payload-level `thinking` string some engine paths persist.
 */
function maskThinking(entry: MessageEntry): MaskedThinking | null {
	const obj = isRecord(entry.payload) ? entry.payload : null;
	if (!obj) return null;
	let blocks = 0;
	let chars = 0;
	let content: unknown[] | undefined;
	if (Array.isArray(obj.content)) {
		content = obj.content.filter((block) => {
			if (!isRecord(block) || block.type !== "thinking") return true;
			blocks += 1;
			if (typeof block.thinking === "string") chars += block.thinking.length;
			return false;
		});
	}
	if (typeof obj.thinking === "string" && obj.thinking.length > 0) {
		blocks += 1;
		chars += obj.thinking.length;
	}
	if (blocks === 0) return null;
	const next = cloneEntry(entry) as MessageEntry;
	next.payload = {
		...obj,
		...(content !== undefined ? { content } : {}),
		thinking: undefined,
		contextCompaction: {
			...(isRecord(obj.contextCompaction) ? obj.contextCompaction : {}),
			stage: "mask_thinking",
			maskedThinkingChars: chars,
			at: new Date().toISOString(),
		},
	};
	return { entry: next, blocks, chars };
}

function isTurnStart(entry: SessionEntry): boolean {
	if (entry.kind === "bashExecution" || entry.kind === "branchSummary") return true;
	return entry.kind === "message" && entry.role === "user";
}

function recentTurnCutoff(entries: ReadonlyArray<SessionEntry>, excludeLastTurns: number): number {
	const horizon = Math.max(1, Math.floor(excludeLastTurns));
	let seen = 0;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || !isTurnStart(entry)) continue;
		seen += 1;
		if (seen >= horizon) return i;
	}
	return 0;
}

function invalidateUsage(entry: SessionEntry): SessionEntry {
	if (entry.kind !== "message" || entry.role !== "assistant") return entry;
	const obj = isRecord(entry.payload) ? entry.payload : null;
	if (!obj || obj.contextUsageInvalidated === true) return entry;
	const next = cloneEntry(entry) as MessageEntry;
	next.payload = {
		...obj,
		contextUsageInvalidated: true,
	};
	return next;
}

export function maskStaleObservations(
	entries: ReadonlyArray<SessionEntry>,
	excludeLastTurns: number,
): MaskObservationsResult {
	const tokensBefore = calculateContextTokens(entries);
	const cutoff = recentTurnCutoff(entries, excludeLastTurns);
	let changed = false;
	let maskedObservations = 0;
	let maskedThinkingBlocks = 0;
	let maskedThinkingChars = 0;
	const next = entries.map((entry, index) => {
		if (index >= cutoff || entry.kind !== "message") return entry;
		if (entry.role === "tool_result") {
			if (alreadyCompacted(entry.payload)) return entry;
			changed = true;
			maskedObservations += 1;
			return maskObservation(entry);
		}
		if (entry.role === "assistant") {
			const masked = maskThinking(entry);
			if (!masked) return entry;
			changed = true;
			maskedThinkingBlocks += masked.blocks;
			maskedThinkingChars += masked.chars;
			return masked.entry;
		}
		return entry;
	});

	const finalEntries = changed ? next.map(invalidateUsage) : next;
	return {
		entries: finalEntries,
		changed,
		tokensBefore,
		tokensAfter: calculateContextTokens(finalEntries),
		maskedObservations,
		maskedThinkingBlocks,
		maskedThinkingChars,
	};
}
