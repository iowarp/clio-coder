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

/**
 * Derive the operator-facing object of a call for the approval overlay: the
 * command for bash, a path for file tools, else a compact args preview.
 * Returns an empty string when nothing meaningful is derivable, so callers
 * can omit the Target row instead of rendering a blank.
 */
export function describeCallTarget(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const str = (value: unknown): string | null =>
		typeof value === "string" && value.trim().length > 0 ? oneLine(sanitizeForDisplay(value)).trim() || null : null;
	const candidate = str(args.command) ?? str(args.path) ?? str(args.file_path) ?? str(args.name) ?? str(args.pattern);
	if (candidate) return candidate;
	try {
		const json = JSON.stringify(args);
		return json === "{}" || json === undefined ? "" : oneLine(sanitizeForDisplay(json)).slice(0, 120);
	} catch {
		return "";
	}
}
