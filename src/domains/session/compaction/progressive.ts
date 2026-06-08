import type { MessageEntry, SessionEntry } from "../entries.js";
import type { ContextCompactionStage } from "./auto.js";
import { calculateContextTokens } from "./tokens.js";

export type ProgressiveCompactionStage = "mask_observations" | "prune_observations" | "mask_dialogue";

export interface ProgressiveCompactionInput {
	entries: ReadonlyArray<SessionEntry>;
	stage: ProgressiveCompactionStage;
	excludeLastTurns: number;
}

export interface ProgressiveCompactionResult {
	stage: ProgressiveCompactionStage;
	entries: SessionEntry[];
	changed: boolean;
	tokensBefore: number;
	tokensAfter: number;
	maskedObservations: number;
	prunedObservations: number;
	maskedDialogue: number;
}

type StoredProgressiveStage = ProgressiveCompactionStage | "llm_summary";

const OBSERVATION_MASK_TEXT = "contents masked to save context";
const _OBSERVATION_PRUNE_TEXT = "output removed to save context";
const DIALOGUE_MASK_TEXT = "message masked to save context";

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

function stringifyPreview(value: unknown, limit = 240): string {
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

function payloadText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!isRecord(payload)) return stringifyPreview(payload, 10_000);
	if (typeof payload.text === "string") return payload.text;
	const contentText = textFromContent(payload.content);
	if (contentText.length > 0) return contentText;
	return stringifyPreview(payload, 10_000);
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return stringifyPreview(result, 10_000);
	const contentText = textFromContent(result.content);
	if (contentText.length > 0) return contentText;
	if (typeof result.text === "string") return result.text;
	if (typeof result.output === "string") return result.output;
	if (typeof result.message === "string") return result.message;
	return stringifyPreview(result, 10_000);
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

function observationMarker(toolName: string, text: string, stage: "mask_observations" | "prune_observations"): string {
	const lines = lineCount(text);
	const chars = text.length;
	if (stage === "prune_observations") {
		return `[Observation pruned: ${toolName} output removed to save context; original was ${lines} lines, ${chars} chars]`;
	}
	const preview = text.trim().replace(/\s+/g, " ").slice(0, 160);
	const suffix = preview.length > 0 ? ` Preview: ${preview}` : "";
	return `[Observation masked: ${toolName} output was ${lines} lines, ${chars} chars - ${OBSERVATION_MASK_TEXT}]${suffix}`;
}

function compactedToolResult(
	original: unknown,
	marker: string,
	stage: "mask_observations" | "prune_observations",
): Record<string, unknown> {
	const details = isRecord(original) && isRecord(original.details) ? { ...original.details } : {};
	return {
		content: [{ type: "text", text: marker }],
		details: {
			...details,
			contextCompaction: { stage, at: new Date().toISOString() },
		},
	};
}

function storedStage(payload: unknown): StoredProgressiveStage | null {
	if (!isRecord(payload)) return null;
	const direct = payload.contextCompaction;
	if (isRecord(direct) && typeof direct.stage === "string") return direct.stage as StoredProgressiveStage;
	const summary = payload.resultSummary;
	if (isRecord(summary)) {
		const nested = summary.contextCompaction;
		if (isRecord(nested) && typeof nested.stage === "string") return nested.stage as StoredProgressiveStage;
	}
	const result = payload.result ?? payload.output ?? payload.out;
	if (isRecord(result) && isRecord(result.details)) {
		const nested = result.details.contextCompaction;
		if (isRecord(nested) && typeof nested.stage === "string") return nested.stage as StoredProgressiveStage;
	}
	return null;
}

function shouldRewriteObservation(entry: MessageEntry, target: "mask_observations" | "prune_observations"): boolean {
	if (entry.role !== "tool_result") return false;
	const stage = storedStage(entry.payload);
	if (stage === "prune_observations" || stage === "mask_dialogue" || stage === "llm_summary") return false;
	return target === "prune_observations" || stage !== "mask_observations";
}

function rewriteObservation(entry: MessageEntry, target: "mask_observations" | "prune_observations"): MessageEntry {
	const next = cloneEntry(entry) as MessageEntry;
	const { obj, result, toolName } = extractToolResultPayload(next.payload);
	const text = resultText(result);
	const marker = observationMarker(toolName, text, target);
	next.payload = {
		...obj,
		result: compactedToolResult(result, marker, target),
		output: undefined,
		out: undefined,
		content: undefined,
		resultSummary: {
			...(isRecord(obj.resultSummary) ? obj.resultSummary : {}),
			bytes: 0,
			truncated: true,
			contextCompaction: {
				stage: target,
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

function firstUserTurnId(entries: ReadonlyArray<SessionEntry>): string | null {
	for (const entry of entries) {
		if (entry.kind === "message" && entry.role === "user") return entry.turnId;
	}
	return null;
}

function containsToolCallBlock(payload: unknown): boolean {
	if (!isRecord(payload) || !Array.isArray(payload.content)) return false;
	return payload.content.some((block) => isRecord(block) && block.type === "toolCall");
}

function dialogueMarker(role: "user" | "assistant", text: string): string {
	const preview = text.trim().replace(/\s+/g, " ").slice(0, 80);
	const prefix = role === "user" ? "Earlier user turn" : "Earlier assistant response";
	const suffix = preview.length > 0 ? ` Preview: ${preview}` : "";
	return `[${prefix} masked: ${DIALOGUE_MASK_TEXT}; original was ${lineCount(text)} lines, ${text.length} chars.]${suffix}`;
}

function rewriteAssistantDialogue(entry: MessageEntry): MessageEntry | null {
	const obj = isRecord(entry.payload) ? entry.payload : null;
	const text = payloadText(entry.payload);
	const marker = dialogueMarker("assistant", text);
	const next = cloneEntry(entry) as MessageEntry;
	if (!obj || !Array.isArray(obj.content)) {
		next.payload = {
			text: marker,
			contextCompaction: { stage: "mask_dialogue", originalChars: text.length, at: new Date().toISOString() },
		};
		return next;
	}
	if (!containsToolCallBlock(obj)) {
		next.payload = {
			...obj,
			content: [{ type: "text", text: marker }],
			contextCompaction: { stage: "mask_dialogue", originalChars: text.length, at: new Date().toISOString() },
		};
		return next;
	}

	let insertedMarker = false;
	const content = obj.content
		.filter((block) => isRecord(block))
		.flatMap((block) => {
			if (block.type === "toolCall") {
				if (insertedMarker) return [{ ...block }];
				insertedMarker = true;
				return [{ type: "text", text: marker }, { ...block }];
			}
			if (block.type === "text" || block.type === "thinking") return [];
			return [{ ...block }];
		});
	next.payload = {
		...obj,
		content,
		contextCompaction: { stage: "mask_dialogue", originalChars: text.length, at: new Date().toISOString() },
	};
	return next;
}

function rewriteDialogue(entry: MessageEntry): MessageEntry | null {
	if (entry.role !== "user" && entry.role !== "assistant") return null;
	if (storedStage(entry.payload) === "mask_dialogue") return null;
	if (entry.role === "assistant") return rewriteAssistantDialogue(entry);
	const text = payloadText(entry.payload);
	const next = cloneEntry(entry) as MessageEntry;
	const obj = isRecord(next.payload) ? next.payload : {};
	next.payload = {
		...obj,
		text: dialogueMarker("user", text),
		content: [{ type: "text", text: dialogueMarker("user", text) }],
		contextCompaction: { stage: "mask_dialogue", originalChars: text.length, at: new Date().toISOString() },
	};
	return next;
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

function appliesObservationStage(stage: ProgressiveCompactionStage): "mask_observations" | "prune_observations" {
	return stage === "mask_observations" ? "mask_observations" : "prune_observations";
}

function progressiveStageRank(stage: ContextCompactionStage): number {
	switch (stage) {
		case "warning":
			return 0;
		case "mask_observations":
			return 1;
		case "prune_observations":
			return 2;
		case "mask_dialogue":
			return 3;
		case "llm_summary":
			return 4;
	}
}

export function isProgressiveCompactionStage(stage: ContextCompactionStage): stage is ProgressiveCompactionStage {
	return stage === "mask_observations" || stage === "prune_observations" || stage === "mask_dialogue";
}

export function shouldAnnounceStage(
	previous: ContextCompactionStage | null | undefined,
	next: ContextCompactionStage,
): boolean {
	return previous === null || previous === undefined || progressiveStageRank(next) > progressiveStageRank(previous);
}

export function applyProgressiveCompaction(input: ProgressiveCompactionInput): ProgressiveCompactionResult {
	const tokensBefore = calculateContextTokens(input.entries);
	const cutoff = recentTurnCutoff(input.entries, input.excludeLastTurns);
	const firstUserId = firstUserTurnId(input.entries);
	let changed = false;
	let maskedObservations = 0;
	let prunedObservations = 0;
	let maskedDialogue = 0;
	const observationStage = appliesObservationStage(input.stage);
	const entries = input.entries.map((entry, index) => {
		let next = entry;
		if (index < cutoff && entry.kind === "message" && shouldRewriteObservation(entry, observationStage)) {
			next = rewriteObservation(entry, observationStage);
			changed = true;
			if (observationStage === "mask_observations") maskedObservations += 1;
			else prunedObservations += 1;
		}
		if (input.stage === "mask_dialogue" && index < cutoff && next.kind === "message" && next.turnId !== firstUserId) {
			const rewritten = rewriteDialogue(next);
			if (rewritten) {
				next = rewritten;
				changed = true;
				maskedDialogue += 1;
			}
		}
		return next;
	});

	const finalEntries = changed ? entries.map(invalidateUsage) : entries;
	const tokensAfter = calculateContextTokens(finalEntries);
	return {
		stage: input.stage,
		entries: finalEntries,
		changed,
		tokensBefore,
		tokensAfter,
		maskedObservations,
		prunedObservations,
		maskedDialogue,
	};
}
