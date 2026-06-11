/**
 * Single-line preview generation for /tree overlay rows.
 *
 * The /tree overlay flattens a TreeSnapshot into one row per turn. The raw
 * snapshot only carries kind + ids + label; this module computes a short,
 * single-line description for each row from the underlying ClioTurnRecord
 * payload so users can recognise turns at a glance instead of seeing a wall
 * of generic `[role]` placeholders.
 *
 * The function is pure: it takes a turn-shape input and returns a string. No
 * I/O, no time, no width-aware truncation (the overlay layer applies its own
 * width budget after calling). Defensive against unknown payload shapes
 * because legacy and v2 sessions both flow through here.
 */
import type { ClioTurnRecord } from "../../../engine/session.js";
import { stripTokenizerSentinels } from "../../../engine/strip-tokenizer-sentinels.js";

/**
 * Maximum characters for the inline preview slice. Keeps a row readable on
 * an 88-column overlay even after the role marker, indent, short turn id,
 * and optional label suffix. Callers that need a tighter budget can clamp
 * the output further.
 */
export const TURN_PREVIEW_MAX_CHARS = 60;

/** Minimal turn shape buildTurnPreview accepts. */
export type TurnPreviewInput = Pick<ClioTurnRecord, "kind" | "payload">;

/**
 * Strip ANSI escape sequences. Tool outputs sometimes carry colour codes
 * that survive into the persisted payload; rendering them inside a single
 * row breaks the overlay's frame because pi-tui's truncateToWidth treats
 * them as zero-width control bytes but our brandedContentRow padding then
 * miscounts. The regexes are constructed from String.fromCharCode(0x1b) so
 * the source file stays free of literal control bytes.
 */
const ESC = String.fromCharCode(0x1b);
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANSI_FALLBACK_RE = new RegExp(`${ESC}[@-_]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_CSI_RE, "").replace(ANSI_FALLBACK_RE, "");
}

/**
 * Collapse all whitespace runs (including newlines, tabs, and CR) into a
 * single space and trim the ends. Combined with stripAnsi + sentinel
 * stripping this guarantees a single-line preview suitable for a row.
 */
function collapseSingleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Apply every defensive cleanup pass we want on persisted text before it
 * shows up in a row. Order matters: ANSI removal must run before whitespace
 * collapse because some CSI sequences embed literal spaces.
 */
function sanitize(text: string): string {
	return collapseSingleLine(stripTokenizerSentinels(stripAnsi(text)));
}

function clamp(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return text.slice(0, max);
	return `${text.slice(0, max - 1)}…`;
}

/**
 * Pull the user-authored or assistant text out of a payload. Handles every
 * shape the engine has persisted over time:
 *   - bare string (oldest legacy)
 *   - `{ text: string }` (current chat-loop output for user; legacy assistant)
 *   - `{ content: [{ type: "text", text }, ...] }` (pi-ai message shape used
 *     by some dispatch glue and assistant turns whose text lives in content)
 * Returns null when no usable text is found.
 */
function extractPlainText(payload: unknown): string | null {
	if (typeof payload === "string") {
		const sanitized = sanitize(payload);
		return sanitized.length > 0 ? sanitized : null;
	}
	if (!payload || typeof payload !== "object") return null;
	const obj = payload as Record<string, unknown>;
	if (typeof obj.text === "string") {
		const sanitized = sanitize(obj.text);
		if (sanitized.length > 0) return sanitized;
	}
	if (Array.isArray(obj.content)) {
		const parts: string[] = [];
		for (const block of obj.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
		if (parts.length > 0) {
			const sanitized = sanitize(parts.join(" "));
			if (sanitized.length > 0) return sanitized;
		}
	}
	return null;
}

/**
 * Identify the most distinguishing argument value for a tool call so the
 * preview reads like a function call. The picked key is heuristic: known
 * tool argument shapes route to their natural identifier; everything else
 * falls back to the first scalar arg.
 */
function pickToolArg(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const preferred: Record<string, ReadonlyArray<string>> = {
		read: ["path"],
		write: ["path"],
		edit: ["path"],
		bash: ["command"],
		code_nav: ["query", "mode"],
		git: ["op"],
		run_task: ["task"],
		grep: ["pattern", "query"],
		search: ["query", "pattern"],
		glob: ["pattern"],
		web_fetch: ["url"],
		web_search: ["query"],
	};
	const order = preferred[toolName] ?? [];
	for (const key of order) {
		const value = a[key];
		if (typeof value === "string" && value.length > 0) return sanitize(value);
		if (typeof value === "number") return String(value);
	}
	// Fallback: first scalar arg, in declaration order.
	for (const [, value] of Object.entries(a)) {
		if (typeof value === "string" && value.length > 0) return sanitize(value);
		if (typeof value === "number" || typeof value === "boolean") return String(value);
	}
	return "";
}

interface ToolCallShape {
	toolName: string;
	args: unknown;
}

function extractToolCall(payload: unknown): ToolCallShape | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	const toolName = typeof p.name === "string" ? p.name : typeof p.toolName === "string" ? p.toolName : null;
	if (!toolName) return null;
	const args = p.args !== undefined ? p.args : (p.arguments ?? p.input);
	return { toolName, args };
}

interface ToolResultShape {
	isError: boolean;
	text: string;
}

function extractToolResult(payload: unknown): ToolResultShape | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	if (!("toolCallId" in p) && !("result" in p) && !("isError" in p)) return null;
	const isError = p.isError === true;
	let text = "";
	const result = p.result;
	if (typeof result === "string") text = result;
	else if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.content)) {
			const parts: string[] = [];
			for (const block of r.content) {
				if (!block || typeof block !== "object") continue;
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			}
			text = parts.join(" ");
		} else if (typeof r.text === "string") {
			text = r.text;
		}
	}
	if (text.length === 0 && typeof p.errorMessage === "string") text = p.errorMessage;
	return { isError, text: sanitize(text) };
}

/**
 * Detect the assistant aborted/error sentinel. Persisted assistant turns
 * carry `stopReason` from the engine; `"aborted"` and `"error"` warrant
 * dedicated markers because the text body is typically empty or partial in
 * those states.
 */
function assistantStopMarker(payload: unknown): "(aborted)" | "(error)" | null {
	if (!payload || typeof payload !== "object") return null;
	const sr = (payload as { stopReason?: unknown }).stopReason;
	if (sr === "aborted") return "(aborted)";
	if (sr === "error") return "(error)";
	return null;
}

/**
 * Compose the per-row preview for a turn. The string is single-line, ANSI-
 * stripped, sentinel-stripped, and clamped to {@link TURN_PREVIEW_MAX_CHARS}.
 * Empty / aborted / streaming-style states get a parenthesised marker so
 * the row never reads as a duplicate of its neighbours.
 */
export function buildTurnPreview(turn: TurnPreviewInput, max: number = TURN_PREVIEW_MAX_CHARS): string {
	const budget = Math.max(1, max);
	switch (turn.kind) {
		case "user": {
			const text = extractPlainText(turn.payload);
			return text === null ? "(empty)" : clamp(text, budget);
		}
		case "assistant": {
			const stop = assistantStopMarker(turn.payload);
			const text = extractPlainText(turn.payload);
			if (text !== null) return clamp(text, budget);
			if (stop !== null) return stop;
			// No text content: typically a tool-call-only turn or a streaming
			// shell that was persisted without a body.
			if (
				turn.payload &&
				typeof turn.payload === "object" &&
				Array.isArray((turn.payload as { content?: unknown }).content)
			) {
				const content = (turn.payload as { content: unknown[] }).content;
				const toolCalls = content.filter(
					(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall",
				);
				if (toolCalls.length > 0) {
					const names = toolCalls
						.map((b) => (b as { name?: unknown }).name)
						.filter((n): n is string => typeof n === "string");
					if (names.length > 0) return clamp(`(tool calls) ${names.join(", ")}`, budget);
				}
			}
			return "(empty)";
		}
		case "tool_call": {
			const call = extractToolCall(turn.payload);
			if (!call) return "(empty)";
			const arg = pickToolArg(call.toolName, call.args);
			const inner = arg.length > 0 ? `"${clamp(arg, Math.max(8, budget - call.toolName.length - 4))}"` : "";
			const composed = `${call.toolName}(${inner})`;
			return clamp(composed, budget);
		}
		case "tool_result": {
			const result = extractToolResult(turn.payload);
			if (!result) return "(empty)";
			const status = result.isError ? "err" : "ok";
			const head = `[${status}]`;
			if (result.text.length === 0) return head;
			const remaining = Math.max(4, budget - head.length - 1);
			return `${head} ${clamp(result.text, remaining)}`;
		}
		case "system": {
			const text = extractPlainText(turn.payload);
			return text === null ? "(system)" : clamp(text, budget);
		}
		case "checkpoint":
			return "(checkpoint)";
		default:
			return `(${String(turn.kind)})`;
	}
}
