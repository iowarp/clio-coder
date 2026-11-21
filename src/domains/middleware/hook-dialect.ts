/**
 * The hook protocols of other coding agents, spoken by a command hook that
 * declares `dialect`. One table per dialect names the agent's tools as Clio's,
 * so the adopter's matcher translation and the stdin payload agree: a ported
 * script reads `tool_name` and `tool_input` in the shapes its agent sends
 * (Claude Code `Edit {file_path, old_string, new_string}`, Codex
 * `apply_patch {command}`), and its JSON answer on stdout decides like exit 2
 * does. Tools a dialect has no name for keep Clio's name and arguments, as both
 * agents do for MCP tools.
 */

import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareEffect, MiddlewareHook } from "./types.js";

export const USER_HOOK_DIALECTS = ["claude-code", "codex"] as const;

export type UserHookDialect = (typeof USER_HOOK_DIALECTS)[number];

export function isUserHookDialect(value: unknown): value is UserHookDialect {
	return typeof value === "string" && (USER_HOOK_DIALECTS as ReadonlyArray<string>).includes(value);
}

/** Each dialect's tool names, as its matchers spell them, to the Clio tool they mean. */
const DIALECT_TOOLS: Readonly<Record<UserHookDialect, Readonly<Record<string, string>>>> = {
	"claude-code": {
		Bash: ToolNames.Bash,
		Read: ToolNames.Read,
		Write: ToolNames.Write,
		Edit: ToolNames.Edit,
		MultiEdit: ToolNames.Edit,
		Glob: ToolNames.Find,
		Grep: ToolNames.Grep,
		LS: ToolNames.Ls,
		WebFetch: ToolNames.WebFetch,
		Task: ToolNames.Dispatch,
	},
	// Codex matches apply_patch under Edit and Write too, and its older builds named the shell tool `shell`.
	codex: {
		Bash: ToolNames.Bash,
		shell: ToolNames.Bash,
		apply_patch: ToolNames.Edit,
		Edit: ToolNames.Edit,
		Write: ToolNames.Write,
	},
};

/** The dialect's matcher names to Clio tool names. */
export function dialectToolNames(dialect: UserHookDialect): Readonly<Record<string, string>> {
	return DIALECT_TOOLS[dialect];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Copy the listed Clio arguments under the dialect's names, leaving out the ones the call did not set. */
function pick(args: Record<string, unknown>, names: Readonly<Record<string, string>>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [from, to] of Object.entries(names)) if (args[from] !== undefined) out[to] = args[from];
	return out;
}

function editPairs(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
	if (!Array.isArray(args.edits)) return [];
	return args.edits.filter(isRecord).map((edit) => ({
		oldText: typeof edit.oldText === "string" ? edit.oldText : "",
		newText: typeof edit.newText === "string" ? edit.newText : "",
	}));
}

const GREP_MODES: Readonly<Record<string, string>> = {
	content: "content",
	files: "files_with_matches",
	count: "count",
};

function claudeToolCall(toolName: string, args: Record<string, unknown>): { name: string; input: unknown } {
	switch (toolName) {
		case ToolNames.Bash:
			return { name: "Bash", input: pick(args, { command: "command", timeout_ms: "timeout" }) };
		case ToolNames.Read:
			return { name: "Read", input: pick(args, { path: "file_path", offset: "offset", limit: "limit" }) };
		case ToolNames.Write:
			return { name: "Write", input: pick(args, { path: "file_path", content: "content" }) };
		case ToolNames.Edit: {
			const edits = editPairs(args);
			const [only] = edits;
			if (edits.length === 1 && only !== undefined)
				return {
					name: "Edit",
					input: { ...pick(args, { path: "file_path" }), old_string: only.oldText, new_string: only.newText },
				};
			return {
				name: "MultiEdit",
				input: {
					...pick(args, { path: "file_path" }),
					edits: edits.map((edit) => ({ old_string: edit.oldText, new_string: edit.newText })),
				},
			};
		}
		case ToolNames.Find:
			return { name: "Glob", input: pick(args, { pattern: "pattern", path: "path" }) };
		case ToolNames.Grep: {
			const input = pick(args, { pattern: "pattern", path: "path", glob: "glob", ignore_case: "-i", context: "-C" });
			if (typeof args.mode === "string" && GREP_MODES[args.mode] !== undefined) input.output_mode = GREP_MODES[args.mode];
			if (args.limit !== undefined) input.head_limit = args.limit;
			return { name: "Grep", input };
		}
		case ToolNames.Ls:
			return { name: "LS", input: pick(args, { path: "path" }) };
		case ToolNames.WebFetch:
			return { name: "WebFetch", input: pick(args, { url: "url" }) };
		case ToolNames.Dispatch:
			return { name: "Task", input: pick(args, { task: "prompt", agent: "subagent_type" }) };
		default:
			return { name: toolName, input: args };
	}
}

function patchLines(prefix: string, text: string): string[] {
	return text.split("\n").map((line) => `${prefix}${line}`);
}

/** Clio's edit or write as the apply_patch text Codex hands its hooks in `tool_input.command`. */
function codexPatch(toolName: string, args: Record<string, unknown>): string {
	const file = typeof args.path === "string" ? args.path : "";
	const body =
		toolName === ToolNames.Write
			? [`*** Add File: ${file}`, ...patchLines("+", typeof args.content === "string" ? args.content : "")]
			: [
					`*** Update File: ${file}`,
					...editPairs(args).flatMap((edit) => ["@@", ...patchLines("-", edit.oldText), ...patchLines("+", edit.newText)]),
				];
	return ["*** Begin Patch", ...body, "*** End Patch", ""].join("\n");
}

function codexToolCall(toolName: string, args: Record<string, unknown>): { name: string; input: unknown } {
	if (toolName === ToolNames.Bash) return { name: "Bash", input: pick(args, { command: "command" }) };
	if (toolName === ToolNames.Edit || toolName === ToolNames.Write)
		return { name: "apply_patch", input: { command: codexPatch(toolName, args) } };
	return { name: toolName, input: args };
}

/** The `tool_name` and `tool_input` a dialect's hook reads for one Clio call. */
export function dialectToolCall(
	dialect: UserHookDialect,
	toolName: string,
	args: unknown,
): { name: string; input: unknown } {
	if (!isRecord(args)) return { name: toolName, input: args };
	return dialect === "codex" ? codexToolCall(toolName, args) : claudeToolCall(toolName, args);
}

/**
 * The effects a dialect hook's JSON answer on stdout (exit 0) decides, in the
 * agents' precedence: `continue: false`, then the PreToolUse
 * `permissionDecision`, then `decision: "block"`, then `additionalContext`.
 * `allow` grants nothing past Clio's own admission. A rewrite through
 * `updatedInput` is refused rather than run unchanged, since a hook that
 * rewrites a call did not agree to the original. Null when stdout is not a JSON
 * object, so the hook's plain-output handling applies.
 */
export function dialectOutputEffects(
	on: MiddlewareHook,
	stdout: string,
	hookId: string,
	maxChars: number,
): MiddlewareEffect[] | null {
	const text = stdout.trim();
	if (!text.startsWith("{")) return null;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(data)) return null;
	const specific = isRecord(data.hookSpecificOutput) ? data.hookSpecificOutput : {};
	const said = (value: unknown): string | undefined =>
		typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxChars) : undefined;
	const fallback = `blocked by hook ${hookId}`;
	const block = (reason: string): MiddlewareEffect => ({ kind: "block_tool", reason, severity: "hard-block" });
	if (data.continue === false) {
		const reason = said(data.stopReason) ?? fallback;
		if (on === "before_tool" || on === "turn_start") return [block(reason)];
		if (on === "after_tool") return [{ kind: "annotate_tool_result", message: reason, severity: "warn" }];
		return [];
	}
	const blocks = data.decision === "block";
	const reason = said(data.reason) ?? said(specific.permissionDecisionReason) ?? fallback;
	const context = said(specific.additionalContext);
	switch (on) {
		case "before_tool": {
			const decision = specific.permissionDecision;
			if (decision === "deny") return [block(said(specific.permissionDecisionReason) ?? reason)];
			if (decision === "ask")
				return [block(`${said(specific.permissionDecisionReason) ?? reason} (the hook asked for approval)`)];
			if (blocks) return [block(reason)];
			if (specific.updatedInput !== undefined)
				return [block(`hook ${hookId} rewrote the call through updatedInput, which CLIO Coder does not apply`)];
			return context !== undefined ? [{ kind: "annotate_tool_result", message: context, severity: "info" }] : [];
		}
		case "after_tool": {
			const effects: MiddlewareEffect[] = [];
			if (blocks) effects.push({ kind: "annotate_tool_result", message: reason, severity: "warn" });
			if (context !== undefined) effects.push({ kind: "annotate_tool_result", message: context, severity: "info" });
			return effects;
		}
		case "turn_start":
			if (blocks) return [block(reason)];
			return context !== undefined ? [{ kind: "inject_reminder", message: context }] : [];
		case "turn_end":
			return blocks ? [{ kind: "request_continuation", message: reason, note: "a hook asked to continue" }] : [];
		default:
			return [];
	}
}
