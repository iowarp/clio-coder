/**
 * Structured renderer for tool-execution chat segments (Slice A of the
 * pi-coding-agent parity work). pi-coding-agent renders every tool call as
 * a header line plus an optional args body and a result/error block. Clio
 * previously emitted a single inline string per call, which collapsed
 * structure (multi-line outputs vanished) and prevented the live and replay
 * paths from sharing one renderer.
 *
 * Pure functions: no I/O, no console writes, no module-level mutable state.
 * The chat-panel tool segment renderer (live path) and the chat-renderer
 * orphan tool-result fallback (replay path) both consume this module so the
 * two surfaces stay byte-identical.
 */

import chalk from "chalk";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import { type DiffRenderInput, renderUnifiedDiff } from "./diff.js";

// Visible width of the rail prefix is 2 columns (`│ `). Width budgets and
// diff renderers compute against the visible length, not the styled length,
// so the constant is kept as the plain-text representation.
const BODY_INDENT_PLAIN = "│ ";
const BODY_INDENT_VISIBLE_WIDTH = 2;
const HEADER_PREFIX_PLAIN = "▸ ";
const ARG_PREVIEW_LIMIT = 60;
const RESULT_PREVIEW_LIMIT = 4000;
const RESULT_LINE_LIMIT = 12;
const ARGS_BODY_LIMIT = 600;
const STATUS_OK_GLYPH = "✓";
const STATUS_ERROR_GLYPH = "✗";

export interface ToolExecutionStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export interface ToolExecutionFinished {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result: unknown;
	isError: boolean;
}

function truncate(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const cut = Math.max(0, limit - 3);
	return `${value.slice(0, cut)}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringField(args: unknown, key: string): string | null {
	if (!isPlainObject(args)) return null;
	const value = args[key];
	return typeof value === "string" ? value : null;
}

function isEmptyArgs(args: unknown): boolean {
	if (args === undefined || args === null) return true;
	if (isPlainObject(args) && Object.keys(args).length === 0) return true;
	return false;
}

function jsonStringifySafe(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return typeof text === "string" ? text : String(value);
	} catch {
		return String(value);
	}
}

/**
 * Map of known tools to their canonical "primary" arg field. When the arg is
 * a string the header summarises it directly and the args body is suppressed
 * because echoing `{"path": "..."}` next to `tool: read(...)` is duplicate
 * noise. Tools not in this map (or with an unexpected arg shape) fall back
 * to a JSON-dump summary plus the full args body.
 */
const PRIMARY_ARG_FIELD: Record<string, string> = {
	read: "path",
	edit: "path",
	write: "path",
	ls: "path",
	bash: "command",
	grep: "pattern",
	glob: "pattern",
	web_fetch: "url",
};

/**
 * Returns the captured primary-arg string when the header successfully used a
 * known tool's canonical arg, otherwise null. Drives the args-body suppression
 * so `tool: read(README.md)` does not get followed by `{"path": "README.md"}`.
 */
function capturedPrimaryArg(toolName: string, args: unknown): string | null {
	const field = PRIMARY_ARG_FIELD[toolName];
	if (field === undefined) return null;
	return readStringField(args, field);
}

/**
 * Pick the most informative single-line summary of a tool's arguments for
 * the header line. Known tools have a canonical "primary" arg (path,
 * command, pattern, url); unknown tools or unexpected shapes fall back to a
 * truncated JSON dump. Returns an empty string when args are absent so the
 * header renders as `tool: <name>()`.
 */
function summarizeArgs(toolName: string, args: unknown): string {
	if (isEmptyArgs(args)) return "";
	const primary = capturedPrimaryArg(toolName, args);
	if (primary !== null) return truncate(primary, ARG_PREVIEW_LIMIT);
	return truncate(jsonStringifySafe(args), ARG_PREVIEW_LIMIT);
}

/**
 * Header status: `undefined` when the call is still in flight (no glyph),
 * `"ok"` for success (green check), `"error"` for failure (red cross). The
 * glyph hangs off the right of the header line so the tool name + args read
 * left-to-right without extra punctuation.
 */
type HeaderStatus = "ok" | "error" | undefined;

function statusGlyph(status: HeaderStatus): string {
	if (status === undefined) return "";
	return status === "ok" ? ` ${chalk.green(STATUS_OK_GLYPH)}` : ` ${chalk.red(STATUS_ERROR_GLYPH)}`;
}

function headerLine(toolName: string, args: unknown, status: HeaderStatus): string {
	const summary = summarizeArgs(toolName, args);
	const head = `${chalk.dim(HEADER_PREFIX_PLAIN)}${chalk.cyan.bold(toolName)}${chalk.dim("(")}${chalk.cyan(summary)}${chalk.dim(")")}`;
	return `${head}${statusGlyph(status)}`;
}

function wrap(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, width);
}

/**
 * Apply the body rail to a line and wrap it. The rail (`│ `) is dim by
 * default and red on error so the tool block reads as a single visual unit
 * even when its result spans many lines.
 */
function indentAndWrap(line: string, width: number, isError: boolean): string[] {
	const railColor = isError ? chalk.red : chalk.dim;
	const rail = railColor(BODY_INDENT_PLAIN);
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	const out: string[] = [];
	for (const wrapped of wrap(line, bodyWidth)) {
		out.push(`${rail}${wrapped}`);
	}
	return out;
}

function renderArgsBody(args: unknown, width: number, isError: boolean): string[] {
	if (isEmptyArgs(args)) return [];
	let pretty: string;
	try {
		const text = JSON.stringify(args, null, 2);
		if (typeof text !== "string") return [];
		pretty = text;
	} catch {
		return [];
	}
	const truncated = truncate(pretty, ARGS_BODY_LIMIT);
	const out: string[] = [];
	for (const raw of truncated.split("\n")) {
		out.push(...indentAndWrap(raw, width, isError));
	}
	return out;
}

/**
 * pi-agent-core wraps tool results in `{ content: [{ type: "text", text }, ...] }`
 * envelopes. Rendering that JSON verbatim hides the actual tool output behind
 * a sea of escaped quotes. When the envelope shape matches, concatenate the
 * text segments and treat the join as the real result; otherwise return the
 * value untouched so callers stringify it normally.
 */
function unwrapResultEnvelope(result: unknown): unknown {
	if (typeof result === "string" || result === null || result === undefined) return result;
	const blocks = Array.isArray(result)
		? result
		: isPlainObject(result) && Array.isArray(result.content)
			? result.content
			: null;
	if (blocks === null) return result;
	const parts: string[] = [];
	for (const block of blocks) {
		if (!isPlainObject(block)) return result;
		if (block.type !== "text" || typeof block.text !== "string") return result;
		parts.push(block.text);
	}
	if (parts.length === 0) return result;
	return parts.join("");
}

function previewResult(result: unknown): string {
	if (typeof result === "string") return truncate(result, RESULT_PREVIEW_LIMIT);
	return truncate(jsonStringifySafe(result), RESULT_PREVIEW_LIMIT);
}

function isEmptyResult(result: unknown): boolean {
	if (result === null || result === undefined) return true;
	if (typeof result === "string" && result.length === 0) return true;
	return false;
}

/**
 * Cap the body of a result block at `RESULT_LINE_LIMIT` lines. When more
 * lines would be shown, replaces the overflow with a single
 * `... <N> more lines hidden` marker so long file reads, grep dumps, and
 * stack traces stay scannable instead of pushing the conversation off-screen.
 */
function capResultLines(lines: ReadonlyArray<string>): string[] {
	if (lines.length <= RESULT_LINE_LIMIT) return [...lines];
	const visible = lines.slice(0, RESULT_LINE_LIMIT);
	const hidden = lines.length - RESULT_LINE_LIMIT;
	visible.push(`... ${hidden} more lines hidden`);
	return visible;
}

interface EditDiffArgs {
	path?: string;
	old_string: string;
	new_string: string;
}

/**
 * Defensive shape check: edit-tool args must carry both `old_string` and
 * `new_string` strings before we can render a diff. `path` is optional; the
 * diff renderer falls back to `"file"` when absent. Anything else falls
 * through to the standard result block so the dispatch is opportunistic and
 * never throws.
 */
function asEditDiffArgs(args: unknown): EditDiffArgs | null {
	if (!isPlainObject(args)) return null;
	const oldString = args.old_string;
	const newString = args.new_string;
	if (typeof oldString !== "string" || typeof newString !== "string") return null;
	const out: EditDiffArgs = { old_string: oldString, new_string: newString };
	if (typeof args.path === "string") out.path = args.path;
	return out;
}

function renderEditDiffBlock(args: EditDiffArgs, width: number): string[] {
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	const input: DiffRenderInput = { oldText: args.old_string, newText: args.new_string };
	if (args.path !== undefined) input.filename = args.path;
	const rail = chalk.dim(BODY_INDENT_PLAIN);
	const out: string[] = [];
	for (const line of renderUnifiedDiff(input, bodyWidth)) {
		out.push(`${rail}${line}`);
	}
	return out;
}

function renderResultBlock(result: unknown, isError: boolean, width: number): string[] {
	const unwrapped = unwrapResultEnvelope(result);
	if (isEmptyResult(unwrapped)) {
		return indentAndWrap(chalk.dim("(no output)"), width, isError);
	}
	const preview = previewResult(unwrapped);
	const lines = capResultLines(preview.split("\n"));
	const out: string[] = [];
	for (const raw of lines) {
		const styled = raw.startsWith("... ") && raw.endsWith(" hidden") ? chalk.dim(raw) : raw;
		out.push(...indentAndWrap(styled, width, isError));
	}
	return out;
}

/**
 * Header-only render for a tool call that has not yet finished. Used by the
 * live chat panel between `tool_execution_start` and `tool_execution_end`.
 * No status glyph: the absence of the glyph signals "still running".
 */
export function renderToolCallHeader(call: ToolExecutionStart, width: number): string[] {
	return wrap(headerLine(call.toolName, call.args, undefined), width);
}

/**
 * Full render: header + args body (if non-empty) + result block. Used by
 * the live chat panel on `tool_execution_end` and by the replay path when a
 * tool result can be paired with its prior call's args. Header carries a
 * green check on success and a red cross on error so the user can scan tool
 * outcomes without reading the body.
 */
export function renderToolExecution(finished: ToolExecutionFinished, width: number): string[] {
	const status: HeaderStatus = finished.isError ? "error" : "ok";
	const out: string[] = [];
	out.push(...wrap(headerLine(finished.toolName, finished.args, status), width));

	// Edit-tool dispatch: when the tool succeeded and `args` carries the
	// expected `{ old_string, new_string }` strings, swap the args body and
	// result block for a unified diff. The header still renders so the user
	// sees `▸ edit(<path>)`, and the args body is suppressed because echoing
	// both strings would just duplicate what the diff already shows.
	if (finished.toolName === "edit" && finished.isError === false) {
		const editArgs = asEditDiffArgs(finished.args);
		if (editArgs !== null) {
			out.push(...renderEditDiffBlock(editArgs, width));
			return out;
		}
	}

	// Suppress the args body when the header already encodes the salient arg
	// (e.g. `▸ read(README.md)` already shows the path; rendering
	// `{"path": "README.md"}` underneath is duplicate noise). For tools without
	// a known primary arg the body still renders so users see what the model
	// actually invoked.
	if (capturedPrimaryArg(finished.toolName, finished.args) === null) {
		out.push(...renderArgsBody(finished.args, width, finished.isError));
	}
	out.push(...renderResultBlock(finished.result, finished.isError, width));
	return out;
}

/**
 * Result-only render for replayed tool results that arrived without a
 * matching prior tool-call entry (orphan results in the session log).
 * Identical to `renderToolExecution` minus the args body.
 */
export function renderToolResultOnly(finished: Omit<ToolExecutionFinished, "args">, width: number): string[] {
	const status: HeaderStatus = finished.isError ? "error" : "ok";
	const out: string[] = [];
	out.push(...wrap(headerLine(finished.toolName, undefined, status), width));
	out.push(...renderResultBlock(finished.result, finished.isError, width));
	return out;
}
