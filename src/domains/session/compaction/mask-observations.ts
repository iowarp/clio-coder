/**
 * Cheap pre-stage for compaction: mask the bodies of tool results older than
 * the protected recent-turn horizon. Tool call/result pairing and metadata
 * survive so replay dependencies stay intact; only the observation body is
 * replaced with a short marker telling the model how to re-fetch.
 *
 * Entries that already carry a `contextCompaction` marker (from any earlier
 * compaction run) are never rewritten again.
 */

import type { MessageEntry, SessionEntry } from "../entries.js";
import { calculateContextTokens } from "./tokens.js";

export interface MaskObservationsResult {
	entries: SessionEntry[];
	changed: boolean;
	tokensBefore: number;
	tokensAfter: number;
	maskedObservations: number;
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
	const next = entries.map((entry, index) => {
		if (index >= cutoff || entry.kind !== "message" || entry.role !== "tool_result") return entry;
		if (alreadyCompacted(entry.payload)) return entry;
		changed = true;
		maskedObservations += 1;
		return maskObservation(entry);
	});

	const finalEntries = changed ? next.map(invalidateUsage) : next;
	return {
		entries: finalEntries,
		changed,
		tokensBefore,
		tokensAfter: calculateContextTokens(finalEntries),
		maskedObservations,
	};
}
