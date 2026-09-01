/**
 * Operator-facing description of what a parked tool call will touch. Shared
 * by the interactive approval overlay (main-agent asks, which hold the call
 * in-process) and the worker runtime (escalations, which must carry the
 * description across the NDJSON stdout seam because the args never leave the
 * worker). Both sides sanitize here so a hostile command string cannot style
 * or spoof the UI that approves it.
 */

import { isSecretArgKey, redactSecretString } from "./redaction.js";

const ESC_CHAR = String.fromCharCode(27);
const BEL_CHAR = String.fromCharCode(7);
// Built through the constructor so no control character appears in a regex
// literal. OSC sequences terminate on BEL, ST (ESC backslash), or end of
// input; CSI sequences are parameter bytes then one final byte.
const OSC_PATTERN = new RegExp(`${ESC_CHAR}\\][\\s\\S]*?(?:${BEL_CHAR}|${ESC_CHAR}\\\\|$)`, "g");
const CSI_PATTERN = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[0-9A-Za-z]`, "g");

function sanitizeForDisplay(value: string): string {
	const stripped = value.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
	let out = "";
	for (const ch of stripped) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : ch;
	}
	return out;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Columns one tab occupies when a multi-line surface expands it. */
const DISPLAY_TAB_WIDTH = 4;

/** Stands in for a control byte that was neutralized, so the cut is visible. */
const CONTROL_BYTE_PLACEHOLDER = "·";

export interface SanitizedDisplayText {
	text: string;
	/** A control byte or escape sequence was neutralized. */
	neutralized: boolean;
	/** A tab was expanded, so column positions are display positions. */
	tabsExpanded: boolean;
}

/**
 * Neutralize escape sequences and control bytes while keeping line structure.
 * {@link sanitizeCallTargetText} is the one-line form for a card; this is the
 * form a multi-line operator surface needs, where the newlines are the content
 * rather than whitespace to collapse. Tabs become spaces because a bordered
 * frame measures visible width and a literal tab makes that measurement a lie.
 * Every other C0 byte and DEL becomes a visible placeholder, so a payload
 * cannot style, reposition, or spoof the surface that is approving it.
 */
export function sanitizeMultilineDisplayText(value: string): SanitizedDisplayText {
	const escapesStripped = value.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
	let neutralized = escapesStripped.length !== value.length;
	// CRLF is line structure, not an injection, so it normalizes rather than
	// showing a placeholder at the end of every line of a Windows-authored file.
	const stripped = escapesStripped.replace(/\r\n/g, "\n");
	let tabsExpanded = false;
	let out = "";
	for (const ch of stripped) {
		if (ch === "\n") {
			out += ch;
			continue;
		}
		if (ch === "\t") {
			out += " ".repeat(DISPLAY_TAB_WIDTH);
			tabsExpanded = true;
			continue;
		}
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			out += CONTROL_BYTE_PLACEHOLDER;
			neutralized = true;
			continue;
		}
		out += ch;
	}
	return { text: out, neutralized, tabsExpanded };
}

/**
 * Neutralize escape sequences and control bytes in a pre-composed target
 * string and collapse it to one line. Used where a description crosses a
 * trust boundary (worker stdout) before it reaches the overlay.
 */
export function sanitizeCallTargetText(value: string): string {
	return oneLine(sanitizeForDisplay(value));
}

/**
 * What a tool call is doing, in the bounded form that may cross the worker
 * stdout seam. The verb comes from a fixed vocabulary and the object from a
 * fixed allowlist of argument fields, so an argument the table does not name
 * cannot reach an operator surface however it is spelled.
 */
export interface CallActionDescriptor {
	/** One word from the vocabulary below naming what the call does. */
	verb: string;
	/** The redacted, bounded thing the call acts on. Absent when nothing safe is derivable. */
	object?: string;
	/** Whether the object was cut to {@link CALL_ACTION_OBJECT_MAX_CHARS}. */
	truncated?: boolean;
}

/**
 * Characters of object text a descriptor carries. Bounded here rather than at
 * the renderer: this string crosses a process boundary, so a hostile argument
 * must be small before it is transported, not after.
 */
export const CALL_ACTION_OBJECT_MAX_CHARS = 64;

/** Maximum characters carried by the approval overlay's one-line call target. */
export const CALL_TARGET_MAX_CHARS = 120;

/**
 * The verb and object field for each tool Clio ships, plus the ACP tool kinds
 * a delegated peer reports. A tool absent from this table gets the neutral
 * `calling` verb, never a verb guessed from its name.
 */
const CALL_ACTION_VOCABULARY: Readonly<Record<string, { verb: string; field: string }>> = {
	read: { verb: "reading", field: "path" },
	edit: { verb: "editing", field: "path" },
	write: { verb: "writing", field: "path" },
	ls: { verb: "listing", field: "path" },
	bash: { verb: "running", field: "command" },
	grep: { verb: "searching", field: "pattern" },
	find: { verb: "finding", field: "pattern" },
	web_fetch: { verb: "fetching", field: "url" },
	git: { verb: "git", field: "op" },
	verify: { verb: "verifying", field: "check" },
	code_nav: { verb: "navigating", field: "query" },
	context: { verb: "context", field: "scope" },
	artifact: { verb: "writing", field: "kind" },
	monitor: { verb: "monitoring", field: "run_id" },
	steer: { verb: "steering", field: "run_id" },
	tasks: { verb: "tasks", field: "action" },
	dispatch: { verb: "dispatching", field: "agent" },
	// ACP tool kinds. A peer names its own argument fields, so these rely on
	// the shared allowlist below rather than on a field this side can predict.
	execute: { verb: "running", field: "command" },
	search: { verb: "searching", field: "query" },
	fetch: { verb: "fetching", field: "url" },
	delete: { verb: "deleting", field: "path" },
	move: { verb: "moving", field: "path" },
	think: { verb: "thinking", field: "" },
};

/**
 * Argument fields any tool may surface as its object. A field outside this
 * list is never read, so a tool that hides a credential in `body`, `headers`,
 * or `env` cannot leak it through a descriptor.
 */
const CALL_ACTION_OBJECT_FIELDS = ["path", "file_path", "command", "pattern", "query", "url"] as const;

/**
 * Argument fields whose values may reach the approval overlay for each tool.
 * Fields are ordered by decision value: the first present field is the plain
 * target, and any later present fields are labeled facts. Everything outside
 * the tool's list is described only by type and size.
 */
const CALL_TARGET_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
	read: ["path", "offset", "limit", "tail"],
	grep: ["pattern", "path", "mode", "glob", "ignore_case", "literal", "context", "limit", "include_ignored"],
	find: ["pattern", "path", "order", "limit", "include_ignored"],
	ls: ["path", "limit"],
	code_nav: ["source", "mode", "query", "limit"],
	context: ["scope", "query", "name", "limit", "ref", "include_tree"],
	credential_present: ["name", "source", "file"],
	write: ["path"],
	edit: ["path"],
	bash: ["command", "cwd", "timeout_ms", "output_policy"],
	git: ["op", "path", "cached", "stat", "name_only", "limit", "cwd", "timeout_ms", "max_output_bytes"],
	verify: ["check", "path", "browser", "cwd", "timeout_ms", "max_output_bytes"],
	dispatch: [
		"list",
		"mode",
		"agent",
		"target",
		"model",
		"node",
		"autonomy",
		"tool_profile",
		"thinking_level",
		"detach",
		"timeout_ms",
	],
	monitor: ["run_id", "mode"],
	steer: ["run_id", "action"],
	tasks: ["action", "id"],
	ledger: ["action", "kind", "path", "line", "target", "passed", "since"],
	web_fetch: ["url", "method", "timeout_ms", "max_bytes", "format"],
	ask_user: ["action", "mode", "max_rounds", "exposure"],
	artifact: ["kind", "path", "title"],
	// ACP tool kinds use only fields whose meaning the protocol defines.
	execute: ["command", "cwd"],
	search: ["query", "path"],
	fetch: ["url", "method"],
	delete: ["path"],
	move: ["path", "target"],
};

/** Sanitize, scrub, and bound one candidate object string. Null when nothing is left. */
function boundActionObject(value: unknown): { object: string; truncated: boolean } | null {
	if (typeof value !== "string") return null;
	const clean = sanitizeCallTargetText(redactSecretString(value));
	if (clean.length === 0) return null;
	if (clean.length <= CALL_ACTION_OBJECT_MAX_CHARS) return { object: clean, truncated: false };
	return { object: clean.slice(0, CALL_ACTION_OBJECT_MAX_CHARS), truncated: true };
}

/**
 * Compose the redacted action descriptor for one tool call. Called at the
 * trusted seams that hold the arguments (the tool registry's admission path,
 * the Claude tool mapper, and the ACP update mapper) so the descriptor, and
 * never the arguments, is what crosses into an operator surface.
 *
 * Returns null when the tool is unknown and no allowlisted field is present:
 * a bare `calling` with nothing after it says less than the tool name already
 * on the row.
 */
export function describeCallAction(
	tool: string,
	args: Record<string, unknown> | undefined,
): CallActionDescriptor | null {
	const known = CALL_ACTION_VOCABULARY[tool];
	const candidates = known?.field ? [known.field, ...CALL_ACTION_OBJECT_FIELDS] : [...CALL_ACTION_OBJECT_FIELDS];
	let bounded: { object: string; truncated: boolean } | null = null;
	if (args) {
		for (const field of candidates) {
			if (isSecretArgKey(field)) continue;
			bounded = boundActionObject(args[field]);
			if (bounded !== null) break;
		}
	}
	if (known === undefined && bounded === null) return null;
	const verb = known?.verb ?? "calling";
	if (bounded === null) return { verb };
	return { verb, object: bounded.object, ...(bounded.truncated ? { truncated: true } : {}) };
}

function renderAllowedTargetValue(value: unknown): string | null {
	if (typeof value === "string") {
		const rendered = sanitizeCallTargetText(redactSecretString(value));
		return rendered.length > 0 ? rendered : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return null;
}

function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** Describe an argument without copying any part of its value into display text. */
function summarizeUnlistedTargetValue(value: unknown): string {
	if (typeof value === "string") {
		return `<string ${countLabel(Buffer.byteLength(value, "utf8"), "byte", "bytes")}>`;
	}
	if (Array.isArray(value)) return `<array ${countLabel(value.length, "item", "items")}>`;
	if (value !== null && typeof value === "object") {
		return `<object ${countLabel(Object.keys(value).length, "field", "fields")}>`;
	}
	if (value === null) return "<null 0 values>";
	if (typeof value === "undefined") return "<undefined 0 values>";
	return `<${typeof value} 1 value>`;
}

function targetFieldName(value: string): string {
	return sanitizeCallTargetText(value).slice(0, 32) || "field";
}

/**
 * Derive the operator-facing object of a call for the approval overlay. Only
 * values in the named tool's allowlist may render. Every other argument is
 * summarized by its field name, type, and size, so an unexpected credential
 * or pasted document still informs the decision without disclosing content.
 * Returns an empty string when the call carries no arguments.
 */
export function describeCallTarget(tool: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const allowedFields = CALL_TARGET_FIELDS[tool] ?? [];
	const allowed = new Set(allowedFields);
	const parts: string[] = [];
	for (const field of allowedFields) {
		if (!(field in args)) continue;
		if (isSecretArgKey(field)) {
			parts.push(`${targetFieldName(field)}=${summarizeUnlistedTargetValue(args[field])}`);
			continue;
		}
		const rendered = renderAllowedTargetValue(args[field]);
		if (rendered === null) {
			parts.push(`${targetFieldName(field)}=${summarizeUnlistedTargetValue(args[field])}`);
			continue;
		}
		parts.push(parts.length === 0 ? rendered : `${targetFieldName(field)}=${rendered}`);
	}
	for (const [field, value] of Object.entries(args)) {
		if (allowed.has(field)) continue;
		parts.push(`${targetFieldName(field)}=${summarizeUnlistedTargetValue(value)}`);
	}
	return sanitizeCallTargetText(parts.join(" · ")).slice(0, CALL_TARGET_MAX_CHARS);
}
