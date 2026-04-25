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

import { wrapTextWithAnsi } from "../../engine/tui.js";
import { type DiffRenderInput, renderUnifiedDiff } from "./diff.js";

const BODY_INDENT = "  ";
const ARG_PREVIEW_LIMIT = 60;
const RESULT_PREVIEW_LIMIT = 600;
const ARGS_BODY_LIMIT = 600;

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
 * Pick the most informative single-line summary of a tool's arguments for
 * the header line. Known tools have a canonical "primary" arg (path,
 * command, pattern, url); unknown tools or unexpected shapes fall back to a
 * truncated JSON dump. Returns an empty string when args are absent so the
 * header renders as `tool: <name>()`.
 */
function summarizeArgs(toolName: string, args: unknown): string {
	if (isEmptyArgs(args)) return "";

	switch (toolName) {
		case "read":
		case "edit":
		case "write":
		case "ls": {
			const path = readStringField(args, "path");
			if (path !== null) return truncate(path, ARG_PREVIEW_LIMIT);
			break;
		}
		case "bash": {
			const command = readStringField(args, "command");
			if (command !== null) return truncate(command, ARG_PREVIEW_LIMIT);
			break;
		}
		case "grep":
		case "glob": {
			const pattern = readStringField(args, "pattern");
			if (pattern !== null) return truncate(pattern, ARG_PREVIEW_LIMIT);
			break;
		}
		case "web_fetch": {
			const url = readStringField(args, "url");
			if (url !== null) return truncate(url, ARG_PREVIEW_LIMIT);
			break;
		}
		default:
			break;
	}

	return truncate(jsonStringifySafe(args), ARG_PREVIEW_LIMIT);
}

function headerLine(toolName: string, args: unknown): string {
	return `tool: ${toolName}(${summarizeArgs(toolName, args)})`;
}

function wrap(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, width);
}

function indentAndWrap(line: string, width: number): string[] {
	return wrap(`${BODY_INDENT}${line}`, width);
}

function renderArgsBody(args: unknown, width: number): string[] {
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
		out.push(...indentAndWrap(raw, width));
	}
	return out;
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
	const bodyWidth = Math.max(1, width - BODY_INDENT.length);
	const input: DiffRenderInput = { oldText: args.old_string, newText: args.new_string };
	if (args.path !== undefined) input.filename = args.path;
	const out: string[] = [];
	for (const line of renderUnifiedDiff(input, bodyWidth)) {
		out.push(`${BODY_INDENT}${line}`);
	}
	return out;
}

function renderResultBlock(result: unknown, isError: boolean, width: number): string[] {
	if (isEmptyResult(result)) {
		return indentAndWrap("(no output)", width);
	}
	const label = isError ? "error:" : "result:";
	const out: string[] = [...indentAndWrap(label, width)];
	const preview = previewResult(result);
	for (const raw of preview.split("\n")) {
		out.push(...indentAndWrap(raw, width));
	}
	return out;
}

/**
 * Header-only render for a tool call that has not yet finished. Used by the
 * live chat panel between `tool_execution_start` and `tool_execution_end`.
 */
export function renderToolCallHeader(call: ToolExecutionStart, width: number): string[] {
	return wrap(headerLine(call.toolName, call.args), width);
}

/**
 * Full render: header + args body (if non-empty) + result block. Used by
 * the live chat panel on `tool_execution_end` and by the replay path when a
 * tool result can be paired with its prior call's args.
 */
export function renderToolExecution(finished: ToolExecutionFinished, width: number): string[] {
	const out: string[] = [];
	out.push(...wrap(headerLine(finished.toolName, finished.args), width));

	// Edit-tool dispatch: when the tool succeeded and `args` carries the
	// expected `{ old_string, new_string }` strings, swap the args body and
	// result block for a unified diff. The header still renders so the user
	// sees `tool: edit(<path>)`, and the args body is suppressed because
	// echoing both strings would just duplicate what the diff already shows.
	if (finished.toolName === "edit" && finished.isError === false) {
		const editArgs = asEditDiffArgs(finished.args);
		if (editArgs !== null) {
			out.push(...renderEditDiffBlock(editArgs, width));
			return out;
		}
	}

	out.push(...renderArgsBody(finished.args, width));
	out.push(...renderResultBlock(finished.result, finished.isError, width));
	return out;
}

/**
 * Result-only render for replayed tool results that arrived without a
 * matching prior tool-call entry (orphan results in the session log).
 * Identical to `renderToolExecution` minus the args body.
 */
export function renderToolResultOnly(finished: Omit<ToolExecutionFinished, "args">, width: number): string[] {
	const out: string[] = [];
	out.push(...wrap(headerLine(finished.toolName, undefined), width));
	out.push(...renderResultBlock(finished.result, finished.isError, width));
	return out;
}
