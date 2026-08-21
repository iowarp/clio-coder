/**
 * Readers for the two message payload shapes the working set acts on:
 * `tool_result` (whose body is replaced by a marker) and `assistant` (whose
 * thinking blocks are dropped).
 *
 * These deliberately mirror the private helpers in
 * `src/domains/session/compaction/mask-observations.ts`. That module is the
 * destructive stage this layer replaces and it goes away once the legacy path
 * is retired, so the working set carries its own copy rather than importing
 * from a module scheduled for deletion. The shapes themselves are not this
 * layer's invention: `turn-persistence.ts` writes
 * `{ toolCallId, toolName, result, isError, resultSummary }`, and `result` is
 * whatever the tool returned, usually `{ content: [...], details: {...} }`.
 */

import type { SessionEntry } from "../../session/entries.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function cloneEntry<T extends SessionEntry>(entry: T): T {
	return structuredClone(entry) as T;
}

export interface ToolResultPayload {
	/** The payload object itself, or a synthetic wrapper when the payload is a bare value. */
	obj: Record<string, unknown>;
	/** The tool's own result value, wherever the payload put it. */
	result: unknown;
	toolName: string;
}

export function toolResultPayload(payload: unknown): ToolResultPayload {
	const obj = isRecord(payload) ? payload : { result: payload };
	const result = obj.result ?? obj.output ?? obj.out ?? obj.content ?? payload;
	const toolName =
		(typeof obj.toolName === "string" && obj.toolName) ||
		(typeof obj.name === "string" && obj.name) ||
		(typeof obj.tool === "string" && obj.tool) ||
		"tool";
	return { obj, result, toolName };
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

function stringifyBody(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

/** The displayed body of a tool result: content text first, then the legacy single-field shapes. */
export function toolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return stringifyBody(result);
	const contentText = textFromContent(result.content);
	if (contentText.length > 0) return contentText;
	if (typeof result.text === "string") return result.text;
	if (typeof result.output === "string") return result.output;
	if (typeof result.message === "string") return result.message;
	return stringifyBody(result);
}

/**
 * Estimated tokens of the body the marker would replace: the text the model
 * reads, not the payload JSON. `details`, `resultSummary`, and the observation
 * envelope never reach the model, so a floor measured on the whole payload
 * would let a two-byte result with a fat envelope through and buy a marker
 * longer than the body it replaced.
 */
export function toolResultBodyTokens(payload: unknown): number {
	return Math.ceil(toolResultText(toolResultPayload(payload).result).length / 4);
}

function nestedRecord(parent: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
	if (parent === null) return null;
	const value = parent[key];
	return isRecord(value) ? value : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
	if (record === null) return undefined;
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Scratch path holding the complete output, when the tool spilled one. Checked
 * in the same order `toolResultSummary` writes it: the OBSERVE envelope, then
 * bash-style result shaping, then the persisted summary that mirrors both.
 */
export function offloadPathOf(payload: ToolResultPayload): string | undefined {
	const details = nestedRecord(isRecord(payload.result) ? payload.result : null, "details");
	return (
		stringField(nestedRecord(details, "resultDisposition"), "offloadPath") ??
		stringField(nestedRecord(details, "observation"), "offloadPath") ??
		stringField(nestedRecord(details, "resultSize"), "offloadPath") ??
		stringField(nestedRecord(payload.obj, "resultSummary"), "offloadPath")
	);
}

/**
 * The one file this result was about, when the tool named exactly one.
 * `edit`, `write`, and `artifact` record `details.paths`; a result naming
 * several is left without a path rather than picking one arbitrarily. Read
 * results carry no `paths`, so the marker falls back to the call's own
 * argument (`callPathsByToolCallId` in path-index.ts).
 */
export function primaryPathOf(payload: ToolResultPayload): string | undefined {
	const details = nestedRecord(isRecord(payload.result) ? payload.result : null, "details");
	const paths = details?.paths;
	if (!Array.isArray(paths) || paths.length !== 1) return undefined;
	const first = paths[0];
	return typeof first === "string" && first.length > 0 ? first : undefined;
}

function isThinkingBlock(block: unknown): boolean {
	return isRecord(block) && block.type === "thinking";
}

/** Both shapes the ledger holds reasoning in: `thinking` content blocks and the payload-level string. */
export function hasThinking(payload: unknown): boolean {
	const obj = isRecord(payload) ? payload : null;
	if (obj === null) return false;
	if (Array.isArray(obj.content) && obj.content.some(isThinkingBlock)) return true;
	return typeof obj.thinking === "string" && obj.thinking.length > 0;
}

export function withoutThinkingBlocks(content: unknown): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	return content.filter((block) => !isThinkingBlock(block));
}

/**
 * True when an earlier destructive compaction run already replaced this body.
 * Such a result has no body left to evict, and re-marking it would spend a
 * marker on a marker. Mirrors `alreadyCompacted()` in mask-observations.ts.
 */
export function hasLegacyCompactionMarker(payload: unknown): boolean {
	if (!isRecord(payload)) return false;
	if (isRecord(payload.contextCompaction)) return true;
	if (isRecord(nestedRecord(payload, "resultSummary")?.contextCompaction)) return true;
	const result = payload.result ?? payload.output ?? payload.out;
	return isRecord(nestedRecord(isRecord(result) ? result : null, "details")?.contextCompaction);
}
