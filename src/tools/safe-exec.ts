import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
import {
	declaredVerificationScripts,
	isVerificationScriptName,
	VERIFICATION_SCRIPT_FAMILY_HINT,
} from "../core/verification-scripts.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const TRUNCATION_MARKER = "\n[output truncated]\n";

function timeoutArg(args: Record<string, unknown>, fallback = SAFE_EXEC_DEFAULT_TIMEOUT_MS): number {
	return typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : fallback;
}

function cwdArg(args: Record<string, unknown>): string | undefined {
	return typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
}

function maxOutputArg(args: Record<string, unknown>): number {
	return typeof args.max_output_bytes === "number" && args.max_output_bytes > 0
		? Math.floor(args.max_output_bytes)
		: SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
}

function resultDetails(result: SafeCommandResult, action: string): ToolResultDetails {
	return {
		action,
		command: [result.file, ...result.args],
		cwd: result.cwd,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		aborted: result.aborted,
		outputCapped: result.outputCapped,
		durationMs: result.durationMs,
	};
}

async function runVectorTool(
	action: string,
	file: string,
	vectorArgs: ReadonlyArray<string>,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	try {
		const runOptions: Parameters<typeof runCommandVector>[2] = {
			timeoutMs: timeoutArg(args),
			maxOutputBytes: maxOutputArg(args),
		};
		const cwd = cwdArg(args);
		if (cwd !== undefined) runOptions.cwd = cwd;
		if (options?.signal !== undefined) runOptions.signal = options.signal;
		const result = await runCommandVector(file, vectorArgs, runOptions);
		const output = truncateUtf8(combineSafeOutput(result), maxOutputArg(args), TRUNCATION_MARKER);
		const details = resultDetails(result, action);
		if (result.aborted) return { kind: "error", message: `${action}: aborted`, details };
		if (result.timedOut) {
			const status = `${action}: timed out after ${timeoutArg(args)}ms`;
			return { kind: "error", message: output.trim().length > 0 ? `${status}\n\n${output.trim()}` : status, details };
		}
		if (result.outputCapped)
			return {
				kind: "error",
				message:
					output.trim().length > 0
						? `${action}: output exceeded ${maxOutputArg(args)} bytes\n\n${output.trim()}`
						: `${action}: output exceeded ${maxOutputArg(args)} bytes`,
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

export const gitTool: ToolSpec = {
	name: ToolNames.Git,
	description: "Read-only git inspection: op=status (short status), diff, or log (oneline).",
	parameters: Type.Object({
		op: stringEnum(["status", "diff", "log"], "Inspection to run."),
		path: Type.Optional(Type.String({ description: "Limit diff/log to one path." })),
		cached: Type.Optional(Type.Boolean({ description: "diff: staged changes (--cached)." })),
		stat: Type.Optional(Type.Boolean({ description: "diff: summary only (--stat)." })),
		name_only: Type.Optional(Type.Boolean({ description: "diff: file names only." })),
		limit: Type.Optional(Type.Number({ description: "log: commits to show (default 20, max 200)." })),
		cwd: Type.Optional(Type.String({ description: "Working directory." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options) {
		const op = typeof args.op === "string" ? args.op : "";
		const pathArg = typeof args.path === "string" && args.path.length > 0 ? args.path : null;
		if (op === "status") {
			return runVectorTool("git", "git", ["status", "--short", "--branch"], args, options);
		}
		if (op === "diff") {
			const vector = ["diff"];
			if (args.cached === true) vector.push("--cached");
			if (args.stat === true) vector.push("--stat");
			if (args.name_only === true) vector.push("--name-only");
			if (pathArg) vector.push("--", pathArg);
			return runVectorTool("git", "git", vector, args, options);
		}
		if (op === "log") {
			const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(200, Math.floor(args.limit)) : 20;
			const vector = ["log", "--oneline", "-n", String(limit)];
			if (pathArg) vector.push("--", pathArg);
			return runVectorTool("git", "git", vector, args, options);
		}
		return { kind: "error", message: `git: op must be status, diff, or log; got '${op}'` };
	},
};

export const runTaskTool: ToolSpec = {
	name: ToolNames.RunTask,
	description:
		"Run a verification script declared in package.json via npm with no shell (names starting with test/lint/build/typecheck/check/format/ci). Pass file paths or flags via args (forwarded after --). Prefer a per-file script such as test:file for single test files when the project declares one.",
	parameters: Type.Object({
		task: Type.String({ description: "Declared verification script name." }),
		args: Type.Optional(Type.Array(Type.String(), { description: "Extra arguments passed after --." })),
		cwd: Type.Optional(Type.String({ description: "Working directory." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)." })),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	async run(args, options) {
		const task = typeof args.task === "string" ? args.task : "";
		if (!isVerificationScriptName(task)) {
			return {
				kind: "error",
				message: `run_task: task '${task}' is not a verification script (${VERIFICATION_SCRIPT_FAMILY_HINT}); run it through bash.`,
			};
		}
		return runPackageScript("run_task", task, args, options);
	},
};

async function runPackageScript(
	action: string,
	script: string,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	let cwd: string;
	try {
		cwd = resolveSafeCwd(cwdArg(args), process.cwd());
	} catch (err) {
		return { kind: "error", message: `${action}: ${err instanceof Error ? err.message : String(err)}` };
	}
	const pkgPath = path.join(cwd, "package.json");
	if (!existsSync(pkgPath)) return { kind: "error", message: `${action}: package.json not found in ${cwd}` };
	const pkg = parsePackageJson(pkgPath);
	if (!pkg.ok) return { kind: "error", message: `${action}: ${pkg.reason}` };
	if (!Object.hasOwn(pkg.scripts, script)) {
		if (action === "run_task") {
			const declared = declaredVerificationScripts(pkg.scripts);
			const list = declared.length > 0 ? declared.join(", ") : "(none)";
			return {
				kind: "error",
				message: `${action}: package.json has no '${script}' script. Declared verification scripts: ${list}.`,
			};
		}
		return { kind: "error", message: `${action}: package.json has no '${script}' script` };
	}
	const extraArgs = Array.isArray(args.args)
		? args.args.filter((entry): entry is string => typeof entry === "string")
		: [];
	const vector = ["run", script];
	if (extraArgs.length > 0) vector.push("--", ...extraArgs);
	return runVectorTool(action, "npm", vector, { ...args, cwd }, options);
}

function parsePackageJson(
	pkgPath: string,
): { ok: true; scripts: Record<string, unknown> } | { ok: false; reason: string } {
	try {
		const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, reason: "package.json root must be an object" };
		}
		const scripts = (parsed as Record<string, unknown>).scripts;
		if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
			return { ok: false, reason: "package.json has no scripts object" };
		}
		return { ok: true, scripts: scripts as Record<string, unknown> };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}
