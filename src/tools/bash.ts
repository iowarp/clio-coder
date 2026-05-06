import { Type } from "typebox";
import { BASH_MAX_OUTPUT_BYTES, buildToolEnv, combineBashOutput, runBashCommand } from "../core/bash-exec.js";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const TRUNCATION_MARKER = "\n[output truncated]\n";

function truncate(text: string): string {
	return truncateUtf8(text, BASH_MAX_OUTPUT_BYTES, TRUNCATION_MARKER);
}

export const bashTool: ToolSpec = {
	name: ToolNames.Bash,
	description:
		"Execute a bash command in the current working directory via /bin/bash -lc. Returns stdout and stderr. Optionally provide a timeout in seconds (or timeout_ms in milliseconds) and a cwd. Default timeout is 5 minutes (300 seconds), enough for npm install and full ci runs.",
	parameters: Type.Object({
		command: Type.String({ description: "Bash command to execute." }),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the command. Defaults to the orchestrator cwd." }),
		),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Alias of timeout_ms. Must be > 0." })),
		timeout_ms: Type.Optional(
			Type.Number({ description: "Timeout in milliseconds. Defaults to 300000 (5 min). Must be > 0." }),
		),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	async run(args, options): Promise<ToolResult> {
		if (typeof args.command !== "string" || args.command.length === 0) {
			return { kind: "error", message: "bash: missing command argument" };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
		const timeoutMsArg = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : null;
		const timeoutSecArg =
			timeoutMsArg === null && typeof args.timeout === "number" && args.timeout > 0 ? args.timeout * 1000 : null;
		const timeout = timeoutMsArg ?? timeoutSecArg ?? 300_000;
		try {
			const result = await runBashCommand(args.command, {
				...(cwd === undefined ? {} : { cwd }),
				timeoutMs: timeout,
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			});
			const { error, aborted, timedOut, outputCapped } = result;
			if (aborted) {
				return { kind: "error", message: "bash: command aborted" };
			}
			if (timedOut) {
				return { kind: "error", message: `bash: command timed out after ${timeout}ms` };
			}
			if (outputCapped) {
				return { kind: "error", message: `bash: command output exceeded ${BASH_MAX_OUTPUT_BYTES * 2} bytes` };
			}
			if (error) {
				const code = typeof error.code === "number" ? error.code : (error as { code?: string }).code;
				const tail = result.stderr.length > 0 ? result.stderr : result.stdout;
				const message = `bash: command failed (exit ${code ?? "?"}): ${truncate(tail).trim() || error.message}`;
				return { kind: "error", message };
			}
			return { kind: "ok", output: truncate(combineBashOutput(result)) };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `bash: ${msg}` };
		}
	},
};

export { buildToolEnv, truncateUtf8 };
