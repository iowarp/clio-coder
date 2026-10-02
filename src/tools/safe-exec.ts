import { Type } from "typebox";
import {
	combineSafeOutput,
	resolveSafeCwd,
	runCommandVector,
	SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES,
	SAFE_EXEC_DEFAULT_TIMEOUT_MS,
	type SafeCommandResult,
} from "../core/safe-exec.js";
import { ToolNames } from "../core/tool-names.js";
import { gitArgvCommand } from "../domains/safety/git-policy.js";
import { StringEnum } from "../engine/ai.js";
import {
	gitConfigBool,
	gitConfigValue,
	resolveGitHooksDirectory,
	typedArgvIsTaskMutation,
	typedGitEnv,
	typedGitInspectEnv,
	typedGitMutationArgv,
} from "./git-exec.js";
import type { ToolInvokeOptions, ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { COMMIT_IDENTITY } from "./task-worktree.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const TRUNCATION_MARKER = "\n[output truncated]\n";

export function timeoutArg(args: Record<string, unknown>, fallback = SAFE_EXEC_DEFAULT_TIMEOUT_MS): number {
	return typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : fallback;
}

function cwdArg(args: Record<string, unknown>): string | undefined {
	return typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
}

export function maxOutputArg(args: Record<string, unknown>): number {
	return typeof args.max_output_bytes === "number" && args.max_output_bytes > 0
		? Math.floor(args.max_output_bytes)
		: SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
}

/**
 * The EXECUTE plane's standardized exec record: what ran, where, how it
 * ended, how long it took, and whether output was capped. Shared by git and
 * verify so ledgers and observers read one shape.
 */
function resultDetails(result: SafeCommandResult): ToolResultDetails {
	return {
		command: [result.file, ...result.args].join(" "),
		argv: [result.file, ...result.args],
		cwd: result.cwd,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		aborted: result.aborted,
		timedOut: result.timedOut,
		outputCapped: result.outputCapped,
	};
}

export async function runVectorTool(
	action: string,
	file: string,
	vectorArgs: ReadonlyArray<string>,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal; env?: Record<string, string>; typedGitWritablePaths?: ReadonlyArray<string> },
): Promise<ToolResult> {
	const timeoutMs = timeoutArg(args);
	const maxOutputBytes = maxOutputArg(args);
	try {
		const runOptions: Parameters<typeof runCommandVector>[2] = { timeoutMs, maxOutputBytes };
		const cwd = cwdArg(args);
		if (cwd !== undefined) runOptions.cwd = cwd;
		if (options?.signal !== undefined) runOptions.signal = options.signal;
		if (options?.env !== undefined) runOptions.env = options.env;
		if (options?.typedGitWritablePaths !== undefined) runOptions.typedGitWritablePaths = options.typedGitWritablePaths;
		const result = await runCommandVector(file, vectorArgs, runOptions);
		const output = truncateUtf8(combineSafeOutput(result), maxOutputBytes, TRUNCATION_MARKER);
		const details = resultDetails(result);
		if (result.aborted) return { kind: "error", message: `${action}: aborted`, details };
		if (result.timedOut) {
			const status = `${action}: timed out after ${timeoutMs}ms`;
			return { kind: "error", message: output.trim().length > 0 ? `${status}\n\n${output.trim()}` : status, details };
		}
		if (result.outputCapped)
			return {
				kind: "error",
				message:
					output.trim().length > 0
						? `${action}: output exceeded ${maxOutputBytes} bytes\n\n${output.trim()}`
						: `${action}: output exceeded ${maxOutputBytes} bytes`,
				details,
			};
		if (result.exitCode !== 0) {
			return {
				kind: "error",
				message: `${action}: exited with code ${result.exitCode ?? "?"}: ${output.trim()}`,
				details,
			};
		}
		return { kind: "ok", output, details };
	} catch (err) {
		return { kind: "error", message: `${action}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

const GIT_OPS = ["status", "diff", "log", "add", "commit"] as const;
const GIT_FIELDS = [
	"op",
	"mode",
	"action",
	"path",
	"paths",
	"message",
	"cached",
	"stat",
	"name_only",
	"limit",
	"cwd",
	"timeout_ms",
	"max_output_bytes",
];

function gitOp(args: Record<string, unknown>): string {
	return typeof args.op === "string"
		? args.op
		: typeof args.mode === "string"
			? args.mode
			: typeof args.action === "string"
				? args.action
				: "";
}

/**
 * Run a typed add or commit. Admission already judged the exact argv; for a
 * worker admitted by its standing allowance rather than an approval, the
 * task worktree and the hooks rule are checked again right before Git runs,
 * because a parallel call could have moved HEAD in between.
 */
async function runTypedGitMutation(
	argv: string[],
	op: "add" | "commit",
	args: Record<string, unknown>,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	let cwd: string;
	try {
		cwd = resolveSafeCwd(cwdArg(args));
	} catch (err) {
		return { kind: "error", message: `git: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!typedArgvIsTaskMutation(argv)) {
		return { kind: "error", message: `git: op ${op} built an argv outside the task set; nothing ran` };
	}
	const context = options?.gitContext;
	if (context !== undefined && (options?.approval === undefined || context.allowance === "worktree")) {
		if (options?.approval === undefined && !context.executePermitted && context.hooksInsideWorkingTree(cwd)) {
			return {
				kind: "error",
				message: `git: op ${op} would run repository hooks from inside the working tree and this permit has no execute capability; nothing ran`,
			};
		}
		const attested = context.taskWorktree?.attest(cwd) ?? {
			ok: false as const,
			detail: "this run owns no task worktree",
		};
		if (!attested.ok) return { kind: "error", message: `git: ${attested.detail}` };
	}
	// Hooks run on typed commits (operator decision Q5). The directory Git
	// resolved is pinned for this one command, so a configuration change after
	// admission cannot swap in another hooks directory.
	const hooks = resolveGitHooksDirectory(cwd);
	if (hooks === null)
		return { kind: "error", message: `git: cannot resolve the hooks directory for ${cwd}; nothing ran` };
	const config: Array<readonly [string, string]> = [["core.hooksPath", hooks.hooks]];
	if (op === "commit") {
		// Signing runs the operator's helper only when the operator's own
		// configuration requires signed commits; otherwise it is off for this
		// command, so no signing program can be selected behind the operator.
		if (gitConfigBool(cwd, "commit.gpgsign") !== true) config.push(["commit.gpgsign", "false"]);
		if (gitConfigValue(cwd, "user.name") === null) config.push(["user.name", COMMIT_IDENTITY]);
		if (gitConfigValue(cwd, "user.email") === null) config.push(["user.email", `${COMMIT_IDENTITY}@local`]);
	}
	const env = typedGitEnv(config, op === "add" ? { GIT_LITERAL_PATHSPECS: "1" } : {});
	return runVectorTool("git", "git", argv, args, {
		...(options?.signal !== undefined ? { signal: options.signal } : {}),
		...(context?.allowance === "worktree" && context.taskWorktree?.typedGitWritablePaths !== undefined
			? { typedGitWritablePaths: context.taskWorktree.typedGitWritablePaths }
			: {}),
		env,
	});
}

export const gitTool: ToolSpec = {
	name: ToolNames.Git,
	description:
		'Git through fixed argv, never a shell. args.op status, diff, or log inspects (for 20 commits use args={op:"log",limit:20}). args.op add stages args.paths (literal paths); args.op commit commits the index with args.message. add and commit need approval unless a worker owns an attested task worktree under git worktree. Free-form command strings are not accepted.',
	parameters: Type.Object({
		// `mode` is what code_nav, evidence and monitor call their selector, and a
		// model reaching for it here spent three calls on "last 3 commits".
		op: Type.Optional(
			StringEnum([...GIT_OPS], {
				description:
					"status, diff, or log to inspect; add (with paths) or commit (with message) to stage and commit. For 20 commits use op=log and limit=20.",
			}),
		),
		mode: Type.Optional(StringEnum([...GIT_OPS], { description: "Same as op." })),
		action: Type.Optional(StringEnum([...GIT_OPS], { description: "Same as op." })),
		path: Type.Optional(Type.String({ description: "Limit diff/log to one path." })),
		paths: Type.Optional(Type.Array(Type.String(), { description: "add: literal paths to stage." })),
		message: Type.Optional(Type.String({ description: "commit: the commit message." })),
		cached: Type.Optional(Type.Boolean({ description: "diff: staged changes (--cached)." })),
		stat: Type.Optional(Type.Boolean({ description: "diff: summary only; log: changed files per commit (--stat)." })),
		name_only: Type.Optional(Type.Boolean({ description: "diff: file names only." })),
		limit: Type.Optional(Type.Number({ description: "log: commits to show (default 20, max 200)." })),
		cwd: Type.Optional(Type.String({ description: "Working directory." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)." })),
		max_output_bytes: Type.Optional(Type.Number({ description: "Output cap in bytes (default 600000)." })),
	}),
	baseActionClass: "read",
	// add and commit write the index and the task branch; two in one batch must not race.
	executionMode: "sequential",
	/**
	 * add and commit are Git mutations, so the safety net and the Git
	 * classifier judge the exact argv they run, spelled as the bash command a
	 * model would have written. Inspection runs as the read it is.
	 */
	safetyCall(args) {
		const built = typedGitMutationArgv(gitOp(args), args);
		if (built === null || !built.ok) return undefined;
		const cwd = cwdArg(args);
		return {
			tool: ToolNames.Bash,
			projection: "typed-git",
			args: { command: gitArgvCommand(built.argv), ...(cwd !== undefined ? { cwd } : {}) },
		};
	},
	async run(args, options) {
		const op = gitOp(args);
		const pathArg = typeof args.path === "string" && args.path.length > 0 ? args.path : null;
		// Inspection never runs an external diff, a text conversion filter, or a pager.
		const inspect = { ...(options?.signal !== undefined ? { signal: options.signal } : {}), env: typedGitInspectEnv() };
		if (op === "status") {
			return runVectorTool("git", "git", ["status", "--short", "--branch"], args, inspect);
		}
		if (op === "diff") {
			const vector = ["diff", "--no-ext-diff", "--no-textconv"];
			if (args.cached === true) vector.push("--cached");
			if (args.stat === true) vector.push("--stat");
			if (args.name_only === true) vector.push("--name-only");
			if (pathArg) vector.push("--", pathArg);
			return runVectorTool("git", "git", vector, args, inspect);
		}
		if (op === "log") {
			const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(200, Math.floor(args.limit)) : 20;
			const vector = ["log", "--no-ext-diff", "--no-textconv", "--oneline", "-n", String(limit)];
			// A merge has no stat by default, and the newest commits of a branch are
			// often merges; the first-parent diff is what the merge brought in.
			if (args.stat === true) vector.push("--stat", "--diff-merges=first-parent");
			if (pathArg) vector.push("--", pathArg);
			return runVectorTool("git", "git", vector, args, inspect);
		}
		const built = typedGitMutationArgv(op, args);
		if (built !== null) {
			if (!built.ok) return { kind: "error", message: built.error };
			return runTypedGitMutation(built.argv, built.op, args, options);
		}
		const unexpected = Object.keys(args).find((key) => !GIT_FIELDS.includes(key));
		return {
			kind: "error",
			message: `git: expected args.op to be status, diff, log, add, or commit; got ${JSON.stringify(op)}${unexpected ? `; unrecognized field ${JSON.stringify(unexpected)}` : ""}. Example: gateway({op:"call",capability:"git",args:{op:"log",limit:20}})`,
		};
	},
};
