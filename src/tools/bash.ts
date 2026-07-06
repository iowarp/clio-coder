import { Type } from "typebox";
import { BASH_HARD_CAP_BYTES, buildToolEnv, combineBashOutput, runBashCommand } from "../core/bash-exec.js";
import { resolveSafeCwd } from "../core/safe-exec.js";
import { ToolNames } from "../core/tool-names.js";
import { expandPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { writeToolOffload } from "./result-shaping.js";
import { DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js";

// What the model sees inline. The tail is where the failing assertion, compiler
// error, and exit summary live, so we keep the LAST lines/bytes. The full
// output is spilled to an offload file before truncating, so nothing is lost.
const BASH_DISPLAY_MAX_BYTES = 16 * 1024;
// Slack reserved so the continuation notice appended after truncation still
// fits under the registry's per-tool bash budget without a second (head-first)
// re-truncation cutting the tail we just preserved.
const BASH_TAIL_NOTE_RESERVE = 512;

interface ShapedBashOutput {
	text: string;
	details?: ToolResultDetails;
}

// Tail-truncate the combined output for display, spilling the full output to a
// scratch file first when it overflows the display cap. Setting
// `details.resultSize.offloadPath` tells the registry result-shaper to leave
// this already-shaped (tail-biased) output alone instead of re-truncating it
// head-first.
function shapeBashOutput(
	rawOutput: string,
	context: Pick<ToolInvokeOptions, "sessionId" | "toolCallId"> | undefined,
): ShapedBashOutput {
	const truncation = truncateTail(rawOutput, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: BASH_DISPLAY_MAX_BYTES - BASH_TAIL_NOTE_RESERVE,
	});
	if (!truncation.truncated) return { text: rawOutput };

	const totalBytes = Buffer.byteLength(rawOutput, "utf8");
	const offloadPath = writeToolOffload(rawOutput, context, BASH_HARD_CAP_BYTES);
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const scope = truncation.lastLinePartial
		? `last ${formatSize(truncation.outputBytes)} of line ${truncation.totalLines} (line is large)`
		: `lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`;
	const location = offloadPath !== null ? ` Full output saved to ${offloadPath}; read it with offset/limit.` : "";
	const note = `[Output tail-truncated: showing ${scope} (${formatSize(BASH_DISPLAY_MAX_BYTES)} display limit).${location}]`;
	const details: ToolResultDetails = {
		resultSize: {
			bytes: totalBytes,
			shownBytes: truncation.outputBytes,
			maxBytes: BASH_DISPLAY_MAX_BYTES,
			truncated: true,
			policy: "tail",
			followUpHint: "Read the full-output offload file with offset/limit, or re-run a narrower command.",
			...(offloadPath !== null ? { offloadPath } : {}),
		},
	};
	return { text: `${truncation.content}\n\n${note}`, details };
}

function withDetails(base: ToolResult, details: ToolResultDetails | undefined): ToolResult {
	if (details === undefined) return base;
	if (base.kind === "ok") return { ...base, details };
	return { ...base, details };
}

// A bash command whose first word is a plain file/dir observer has a
// structured OBSERVE counterpart with paged, budget-aware results.
const OBSERVE_COMMAND_PATTERN = /^\s*(?:cat|head|tail|ls|grep|rg|find)\b/;

const OBSERVE_NUDGE_SESSION_LIMIT = 64;
const observeNudgeSeenSessions = new Set<string>();

/**
 * One nudge per session, on the first successful observer-shaped bash call.
 * Point-of-failure conditioning like the edit-result validation nudge:
 * measured orientation runs opened with ten bash cat/ls calls while the
 * structured observe tools sat unused in the surface; result-time text beats
 * static prompt lines. Appending to the result keeps the per-session tool
 * surface and prompt prefix byte-stable.
 */
function observeToolsNudge(command: string, sessionId: string | undefined): string {
	if (!OBSERVE_COMMAND_PATTERN.test(command)) return "";
	const key = sessionId ?? "no-session";
	if (observeNudgeSeenSessions.has(key)) return "";
	if (observeNudgeSeenSessions.size >= OBSERVE_NUDGE_SESSION_LIMIT) {
		const oldest = observeNudgeSeenSessions.values().next().value;
		if (oldest !== undefined) observeNudgeSeenSessions.delete(oldest);
	}
	observeNudgeSeenSessions.add(key);
	return (
		"\n\n[note: prefer the structured observe tools over shell file inspection: read pages files with " +
		"offset/limit, ls lists directories, grep and find search, code_nav maps symbols. Their results are " +
		"capped and continuable; keep bash for builds, git, and scripts.]"
	);
}

export const bashTool: ToolSpec = {
	name: ToolNames.Bash,
	description:
		"Execute a bash command and return stdout and stderr. Runs inside the session workspace. Default timeout 300000 ms.",
	parameters: Type.Object({
		command: Type.String({ description: "Bash command to execute." }),
		cwd: Type.Optional(Type.String({ description: "Working directory; must stay inside the session workspace." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	async run(args, options): Promise<ToolResult> {
		if (typeof args.command !== "string" || args.command.length === 0) {
			return { kind: "error", message: "bash: missing command argument" };
		}
		const cwdArg = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
		// Pin the child's cwd inside the session workspace in the tool itself.
		// The safety net blocks escaping cwd arguments at admission; this is the
		// defense-in-depth mirror for paths that reach the tool directly, and it
		// resolves `~` before checking so a home-relative cwd cannot slip past
		// as an unexpanded literal.
		let cwd: string;
		try {
			cwd = resolveSafeCwd(cwdArg === undefined ? undefined : expandPath(cwdArg), process.cwd());
		} catch {
			return {
				kind: "error",
				message: `bash: cwd '${cwdArg}' escapes workspace root '${process.cwd()}'; use a typed tool or a project policy entry with explicit cwd`,
			};
		}
		const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 300_000;
		try {
			const result = await runBashCommand(args.command, {
				cwd,
				timeoutMs: timeout,
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			});
			const { error, aborted, timedOut, outputCapped } = result;
			if (aborted) {
				return { kind: "error", message: "bash: command aborted" };
			}
			const shaped = shapeBashOutput(combineBashOutput(result), options);
			const output = shaped.text.trim();
			if (timedOut) {
				const status = `bash: command timed out after ${timeout}ms`;
				return withDetails(
					{ kind: "error", message: output.length > 0 ? `${output}\n\n${status}` : status },
					shaped.details,
				);
			}
			if (outputCapped) {
				const status = `bash: command output exceeded ${BASH_HARD_CAP_BYTES} bytes and was stopped`;
				return withDetails(
					{ kind: "error", message: output.length > 0 ? `${output}\n\n${status}` : status },
					shaped.details,
				);
			}
			if (error) {
				const code = typeof error.code === "number" ? error.code : (error as { code?: string }).code;
				const status = `bash: command failed (exit ${code ?? "?"})`;
				const message = output.length > 0 ? `${output}\n\n${status}` : `${status}: ${error.message}`;
				return withDetails({ kind: "error", message }, shaped.details);
			}
			const body = shaped.text.length > 0 ? shaped.text : "(no output)";
			return withDetails(
				{ kind: "ok", output: `${body}${observeToolsNudge(args.command, options?.sessionId)}` },
				shaped.details,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `bash: ${msg}` };
		}
	},
};

export { buildToolEnv };
