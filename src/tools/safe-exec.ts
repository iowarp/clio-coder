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
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const TRUNCATION_MARKER = "\n[output truncated]\n";
const STANDARD_PACKAGE_SCRIPTS = new Set(["test", "test:e2e", "lint", "build", "typecheck", "ci"]);

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

const commonExecParams = {
	cwd: Type.Optional(Type.String({ description: "Working directory under the workspace root." })),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 120000." })),
	max_output_bytes: Type.Optional(Type.Number({ description: "Maximum combined stdout/stderr bytes." })),
} as const;

export const gitStatusTool: ToolSpec = {
	name: ToolNames.GitStatus,
	description: "Run `git status --short --branch` using a fixed command vector.",
	parameters: Type.Object(commonExecParams),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options) {
		return runVectorTool("git_status", "git", ["status", "--short", "--branch"], args, options);
	},
};

export const gitDiffTool: ToolSpec = {
	name: ToolNames.GitDiff,
	description: "Run a constrained git diff. Supports cached, stat, name_only, and one optional path.",
	parameters: Type.Object({
		cached: Type.Optional(Type.Boolean({ description: "Use --cached." })),
		stat: Type.Optional(Type.Boolean({ description: "Use --stat." })),
		name_only: Type.Optional(Type.Boolean({ description: "Use --name-only." })),
		path: Type.Optional(Type.String({ description: "Optional path under the repository." })),
		...commonExecParams,
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options) {
		const vector = ["diff"];
		if (args.cached === true) vector.push("--cached");
		if (args.stat === true) vector.push("--stat");
		if (args.name_only === true) vector.push("--name-only");
		if (typeof args.path === "string" && args.path.length > 0) vector.push("--", args.path);
		return runVectorTool("git_diff", "git", vector, args, options);
	},
};

export const gitLogTool: ToolSpec = {
	name: ToolNames.GitLog,
	description: "Run `git log --oneline` with a bounded limit and optional path.",
	parameters: Type.Object({
		limit: Type.Optional(Type.Number({ description: "Number of commits to show. Defaults to 20, max 200." })),
		path: Type.Optional(Type.String({ description: "Optional path under the repository." })),
		...commonExecParams,
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options) {
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(200, Math.floor(args.limit)) : 20;
		const vector = ["log", "--oneline", "-n", String(limit)];
		if (typeof args.path === "string" && args.path.length > 0) vector.push("--", args.path);
		return runVectorTool("git_log", "git", vector, args, options);
	},
};

export const runTestsTool: ToolSpec = packageScriptTool(
	ToolNames.RunTests,
	"test",
	"Run the standard project test script.",
);
export const runLintTool: ToolSpec = packageScriptTool(
	ToolNames.RunLint,
	"lint",
	"Run the standard project lint script.",
);
export const runBuildTool: ToolSpec = packageScriptTool(
	ToolNames.RunBuild,
	"build",
	"Run the standard project build script.",
);

export const packageScriptToolSpec: ToolSpec = {
	name: ToolNames.PackageScript,
	description: "Run one standard package.json validation script by name through `npm run <script>` with no shell.",
	parameters: Type.Object({
		script: Type.String({ description: "Script name. Must be one of test, test:e2e, lint, build, typecheck, ci." }),
		args: Type.Optional(Type.Array(Type.String(), { description: "Additional plain arguments passed after --." })),
		...commonExecParams,
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	async run(args, options) {
		const script = typeof args.script === "string" ? args.script : "";
		if (!STANDARD_PACKAGE_SCRIPTS.has(script)) {
			return { kind: "error", message: `package_script: script '${script}' is not in the standard allowlist` };
		}
		return runPackageScript("package_script", script, args, options);
	},
};

function packageScriptTool(name: ToolSpec["name"], script: string, description: string): ToolSpec {
	return {
		name,
		description: `${description} Uses npm with a fixed argv vector and structured result details.`,
		parameters: Type.Object({
			args: Type.Optional(Type.Array(Type.String(), { description: "Additional plain arguments passed after --." })),
			...commonExecParams,
		}),
		baseActionClass: "execute",
		executionMode: "sequential",
		async run(args, options) {
			return runPackageScript(name, script, args, options);
		},
	};
}

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
