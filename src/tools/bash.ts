import { Type } from "typebox";
import { BASH_HARD_CAP_BYTES, combineBashOutput, runBashCommand } from "../core/bash-exec.js";
import { resolveSafeCwd } from "../core/safe-exec.js";
import { ToolNames } from "../core/tool-names.js";
import { expandPath } from "./path-utils.js";
import { toolPresentationPolicy } from "./presentation.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import {
	deterministicDiagnosticSummary,
	type NormalizedToolResultDisposition,
	type ToolResultContextDisposition,
	type ToolResultDisposition,
} from "./result-disposition.js";
import { DEFAULT_MAX_LINES, truncateTail } from "./truncate.js";
import { byteLength } from "./truncate-utf8.js";

// The registry's bounded model projection and operator presentation share this
// cap. Both are tail-biased for Bash because diagnostics usually land last.
const BASH_DISPLAY_MAX_BYTES = 16 * 1024;
export type BashOutputPolicy = "full" | "bounded" | "summary" | "metadata-only";

const BASH_OUTPUT_POLICIES = new Set<BashOutputPolicy>(["full", "bounded", "summary", "metadata-only"]);

function bashContextDisposition(policy: BashOutputPolicy): ToolResultContextDisposition & { maxBytes: number } {
	if (policy === "full") {
		return { mode: "full", maxBytes: BASH_DISPLAY_MAX_BYTES, downgradeExcerpt: "tail" };
	}
	if (policy === "summary") {
		return {
			mode: "summary",
			maxBytes: BASH_DISPLAY_MAX_BYTES,
			strategy: "diagnostic",
			redact: true,
		};
	}
	if (policy === "metadata-only") return { mode: "metadata-only", maxBytes: BASH_DISPLAY_MAX_BYTES };
	return { mode: "bounded", maxBytes: BASH_DISPLAY_MAX_BYTES, excerpt: "tail" };
}

/** Canonical default attached by the builtin catalog and reused by direct registries. */
export const BASH_DEFAULT_RESULT_DISPOSITION: ToolResultDisposition = {
	presentation: {
		...toolPresentationPolicy(ToolNames.Bash, undefined),
		maxBytes: BASH_DISPLAY_MAX_BYTES,
		overflow: "tail",
	},
	context: bashContextDisposition("bounded"),
};

/** Pure, idempotent normalization used by registry admission and direct calls. */
function normalizeBashArguments(args: Record<string, unknown>): Record<string, unknown> {
	return args.output_policy === undefined ? { ...args, output_policy: "bounded" } : args;
}

function bashOutputPolicy(args: Record<string, unknown>): BashOutputPolicy | null {
	const value = args.output_policy;
	return typeof value === "string" && BASH_OUTPUT_POLICIES.has(value as BashOutputPolicy)
		? (value as BashOutputPolicy)
		: null;
}

function resolveBashResultDisposition(
	args: Record<string, unknown>,
	declared: ToolResultDisposition | undefined = BASH_DEFAULT_RESULT_DISPOSITION,
): ToolResultDisposition {
	const policy = bashOutputPolicy(args) ?? "bounded";
	const base = declared ?? BASH_DEFAULT_RESULT_DISPOSITION;
	return { presentation: base.presentation, context: bashContextDisposition(policy) };
}

function normalizedBashDisposition(policy: BashOutputPolicy): NormalizedToolResultDisposition {
	return {
		presentation: { ...BASH_DEFAULT_RESULT_DISPOSITION.presentation, maxBytes: BASH_DISPLAY_MAX_BYTES },
		context: bashContextDisposition(policy),
	};
}

/** Bound a cumulative live snapshot without writing an offload file per tick. */
function shapeBashProgress(rawOutput: string, outputBytes: number, policy: BashOutputPolicy): ToolResult {
	const disposition = normalizedBashDisposition(policy);
	let output: string;
	if (policy === "metadata-only") {
		output = `bash: running; captured ${outputBytes} bytes; stdout/stderr omitted by metadata-only policy`;
	} else if (policy === "summary") {
		output = deterministicDiagnosticSummary(rawOutput, BASH_DISPLAY_MAX_BYTES, true).text;
	} else {
		output = truncateTail(rawOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: disposition.context.maxBytes,
		}).content;
	}
	return {
		kind: "ok",
		output,
		details: {
			resultSize: {
				bytes: outputBytes,
				shownBytes: byteLength(output),
				maxBytes: BASH_DISPLAY_MAX_BYTES,
				truncated: byteLength(rawOutput) > byteLength(output),
				policy,
			},
		},
	};
}

function bashResultDetails(
	result: Awaited<ReturnType<typeof runBashCommand>>,
	rawOutput: string,
	outcome: "success" | "nonzero" | "timeout" | "abort" | "output-cap",
): ToolResultDetails {
	return {
		outcome,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		aborted: result.aborted,
		outputCapped: result.outputCapped,
		outputBytes: result.outputBytes,
		retainedBytes: byteLength(rawOutput),
		stdoutBytes: byteLength(result.stdout),
		stderrBytes: byteLength(result.stderr),
	};
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
		"Execute a bash command inside the session workspace. output_policy controls model context: bounded keeps the diagnostic tail and is the default; summary keeps deterministic redacted diagnostics; metadata-only keeps facts and retrieval; full is admitted only within the result budget.",
	parameters: Type.Object({
		command: Type.String({ description: "Bash command to execute." }),
		cwd: Type.Optional(
			Type.String({
				description:
					"Omit unless the command must run in a subdirectory of the workspace root, given as a relative path; outside the root is blocked.",
			}),
		),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
		output_policy: Type.Optional(
			Type.Union([Type.Literal("full"), Type.Literal("bounded"), Type.Literal("summary"), Type.Literal("metadata-only")], {
				description:
					"Model-context disposition. Omit for bounded tail output. Use summary for noisy runs, metadata-only when only status and retrieval matter, and full only for known-small output.",
			}),
		),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	prepareArguments: normalizeBashArguments,
	resolveResultDisposition: resolveBashResultDisposition,
	async run(args, options): Promise<ToolResult> {
		args = normalizeBashArguments(args);
		if (typeof args.command !== "string" || args.command.length === 0) {
			return { kind: "error", message: "bash: missing command argument" };
		}
		const outputPolicy = bashOutputPolicy(args);
		if (outputPolicy === null) {
			return {
				kind: "error",
				message: "bash: output_policy must be one of full, bounded, summary, or metadata-only (omit it for bounded)",
				details: { outcome: "invalid-arguments", exitCode: null },
			};
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
			const runOptions: Parameters<typeof runBashCommand>[1] = {
				cwd,
				timeoutMs: timeout,
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			};
			if (options?.onUpdate !== undefined) {
				runOptions.onUpdate = (progress) => {
					options.onUpdate?.(shapeBashProgress(combineBashOutput(progress), progress.outputBytes, outputPolicy));
				};
			}
			const result = await runBashCommand(args.command, runOptions);
			const { error, aborted, timedOut, outputCapped } = result;
			const rawOutput = combineBashOutput(result);
			const output = rawOutput.trim();
			if (aborted) {
				const status = "bash: command aborted";
				return {
					kind: "error",
					message: output.length > 0 ? `${output}\n\n${status}` : status,
					details: bashResultDetails(result, rawOutput, "abort"),
				};
			}
			if (timedOut) {
				const status = `bash: command timed out after ${timeout}ms`;
				return {
					kind: "error",
					message: output.length > 0 ? `${output}\n\n${status}` : status,
					details: bashResultDetails(result, rawOutput, "timeout"),
				};
			}
			if (outputCapped) {
				const status = `bash: command output exceeded ${BASH_HARD_CAP_BYTES} bytes and was stopped`;
				return {
					kind: "error",
					message: output.length > 0 ? `${output}\n\n${status}` : status,
					details: bashResultDetails(result, rawOutput, "output-cap"),
				};
			}
			if (error) {
				const code = typeof error.code === "number" ? error.code : (error as { code?: string }).code;
				const status = `bash: command failed (exit ${code ?? "?"})`;
				const message = output.length > 0 ? `${output}\n\n${status}` : `${status}: ${error.message}`;
				return { kind: "error", message, details: bashResultDetails(result, rawOutput, "nonzero") };
			}
			const body = rawOutput.length > 0 ? rawOutput : "(no output)";
			return {
				kind: "ok",
				output: `${body}${observeToolsNudge(args.command, options?.sessionId)}`,
				details: bashResultDetails(result, rawOutput, "success"),
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `bash: ${msg}` };
		}
	},
};
