/**
 * Exact recall by ref.
 *
 * A `contextEviction` entry removes a tool-result body from the projection
 * and leaves a marker naming the ref. Recall is the reverse move: given a ref
 * on the active path whose key the fold still lists as evicted, hand back the
 * original body byte-exact and describe the `contextRecall` entry the caller
 * appends so the next fold readmits it. Pure over entries: nothing here reads
 * the session, writes the ledger, or calls a model.
 *
 * The body is read the way `compaction/mask-observations.ts` reads a
 * tool_result payload (`resultText`), so what recall returns is exactly what
 * the projection would have rendered before eviction. No truncation happens
 * here; the observation envelope applies the per-turn caps.
 */

import { ceilChars } from "../../session/context-accounting.js";
import type { MessageEntry, SessionEntry } from "../../session/entries.js";
import { filterEntriesToActivePath } from "../../session/tree/active-path.js";
import type { ContextRecallFields, RecallError, RecallResult, RecallTrigger, WorkingSetView } from "./contract.js";
import { parseRefKey, refKey } from "./fold.js";

export type RecallOutcome = { ok: true; result: RecallResult } | { ok: false; error: RecallError };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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

function stringifyWhole(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

/** Same field precedence as `resultText` in mask-observations.ts, without the preview cap. */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return stringifyWhole(result);
	const contentText = textFromContent(result.content);
	if (contentText.length > 0) return contentText;
	if (typeof result.text === "string") return result.text;
	if (typeof result.output === "string") return result.output;
	if (typeof result.message === "string") return result.message;
	return stringifyWhole(result);
}

function extractToolResult(payload: unknown): unknown {
	const obj = isRecord(payload) ? payload : { result: payload };
	return obj.result ?? obj.output ?? obj.out ?? obj.content ?? payload;
}

function offloadPathOf(result: unknown): string | undefined {
	if (!isRecord(result) || !isRecord(result.details)) return undefined;
	const details = result.details;
	for (const key of ["resultSize", "observation"] as const) {
		const record = details[key];
		if (isRecord(record) && typeof record.offloadPath === "string" && record.offloadPath.length > 0) {
			return record.offloadPath;
		}
	}
	return undefined;
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
	return i;
}

/**
 * The evicted ref key sharing the longest non-empty common prefix with `key`,
 * or null when no evicted key shares a prefix. Ties keep fold order, which is
 * ledger order of the eviction events.
 */
function nearestEvictedRef(view: WorkingSetView, key: string): string | null {
	let best: string | null = null;
	let bestLength = 0;
	for (const candidate of view.evicted.keys()) {
		const length = commonPrefixLength(candidate, key);
		if (length > bestLength) {
			best = candidate;
			bestLength = length;
		}
	}
	return best;
}

function isThinkingEntry(entry: SessionEntry): boolean {
	return entry.kind === "message" && entry.role === "assistant";
}

function isToolResultEntry(entry: SessionEntry): entry is MessageEntry {
	return entry.kind === "message" && entry.role === "tool_result";
}

export function resolveRecall(
	entries: ReadonlyArray<SessionEntry>,
	view: WorkingSetView,
	ref: string,
	activeLeafTurnId?: string,
): RecallOutcome {
	const parsed = parseRefKey(ref);
	if (parsed === null) return { ok: false, error: { kind: "invalid_ref", ref } };
	const key = refKey(parsed);
	const active = filterEntriesToActivePath(entries, activeLeafTurnId);
	const entry = active.find((candidate) => candidate.turnId === key);
	if (entry === undefined) {
		return { ok: false, error: { kind: "not_on_active_path", ref: key, nearest: nearestEvictedRef(view, key) } };
	}
	// Thinking leaves the working set without a marker and is not recallable
	// in this slice; `recallErrorMessage` names that case from the entry.
	if (isThinkingEntry(entry) || !view.evicted.has(key) || !isToolResultEntry(entry)) {
		return { ok: false, error: { kind: "not_evicted", ref: key, nearest: nearestEvictedRef(view, key) } };
	}
	const result = extractToolResult(entry.payload);
	const body = resultText(result);
	const offloadPath = offloadPathOf(result);
	return {
		ok: true,
		result: {
			ref: parsed,
			entry,
			body,
			tokens: ceilChars(body.length),
			...(offloadPath !== undefined ? { offloadPath } : {}),
		},
	};
}

export function buildRecallFields(
	result: RecallResult,
	meta: { trigger: RecallTrigger; toolCallId?: string },
): ContextRecallFields {
	return {
		kind: "contextRecall",
		ref: { entry: result.ref.entry },
		trigger: meta.trigger,
		tokensReadmitted: result.tokens,
		...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
	};
}

/**
 * One-line operator/model-facing message for a recall failure. Names the
 * nearest valid ref when one exists so the next call can succeed, and says
 * why an assistant turn is refused instead of calling it "not evicted".
 */
export function recallErrorMessage(error: RecallError, entries: ReadonlyArray<SessionEntry> = []): string {
	const nearest = "nearest" in error && error.nearest !== null ? ` Nearest evicted ref: ${error.nearest}.` : "";
	switch (error.kind) {
		case "invalid_ref":
			return `recall ref must be a single turnId without whitespace; got '${error.ref}'.`;
		case "not_on_active_path":
			return `ref ${error.ref} is not on the active path of this session (unknown or on an abandoned branch).${nearest}`;
		case "not_evicted": {
			const entry = entries.find((candidate) => candidate.turnId === error.ref);
			if (entry !== undefined && isThinkingEntry(entry)) {
				return `ref ${error.ref} is an assistant turn; thinking is not recallable.${nearest}`;
			}
			return `ref ${error.ref} is not evicted; its content is already in context.${nearest}`;
		}
	}
}
