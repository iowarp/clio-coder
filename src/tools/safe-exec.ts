import { Type } from "typebox";
import {
	combineSafeOutput,
	runCommandVector,
	SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES,
	SAFE_EXEC_DEFAULT_TIMEOUT_MS,
	type SafeCommandResult,
} from "../core/safe-exec.js";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";
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
		cwd: result.cwd,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		timedOut: result.timedOut,
		outputCapped: result.outputCapped,
	};
}

export async function runVectorTool(
	action: string,
	file: string,
	vectorArgs: ReadonlyArray<string>,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	const timeoutMs = timeoutArg(args);
	const maxOutputBytes = maxOutputArg(args);
	try {
		const runOptions: Parameters<typeof runCommandVector>[2] = { timeoutMs, maxOutputBytes };
		const cwd = cwdArg(args);
		if (cwd !== undefined) runOptions.cwd = cwd;
		if (options?.signal !== undefined) runOptions.signal = options.signal;
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
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)." })),
		max_output_bytes: Type.Optional(Type.Number({ description: "Output cap in bytes (default 600000)." })),
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
