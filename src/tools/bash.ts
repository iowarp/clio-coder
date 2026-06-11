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
	description: "Execute a bash command via /bin/bash -lc and return stdout and stderr. Default timeout 300000 ms.",
	parameters: Type.Object({
		command: Type.String({ description: "Bash command to execute." }),
		cwd: Type.Optional(Type.String({ description: "Working directory." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	async run(args, options): Promise<ToolResult> {
		if (typeof args.command !== "string" || args.command.length === 0) {
			return { kind: "error", message: "bash: missing command argument" };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
		const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 300_000;
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
				const output = truncate(combineBashOutput(result)).trim();
				const status = `bash: command timed out after ${timeout}ms`;
				return { kind: "error", message: output.length > 0 ? `${output}\n\n${status}` : status };
			}
			if (outputCapped) {
				const output = truncate(combineBashOutput(result)).trim();
				const status = `bash: command output exceeded ${BASH_MAX_OUTPUT_BYTES * 2} bytes`;
				return { kind: "error", message: output.length > 0 ? `${output}\n\n${status}` : status };
			}
			if (error) {
				const code = typeof error.code === "number" ? error.code : (error as { code?: string }).code;
				const output = truncate(combineBashOutput(result)).trim();
				const status = `bash: command failed (exit ${code ?? "?"})`;
				const message = output.length > 0 ? `${output}\n\n${status}` : `${status}: ${error.message}`;
				return { kind: "error", message };
			}
			const output = truncate(combineBashOutput(result));
			return { kind: "ok", output: output.length > 0 ? output : "(no output)" };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `bash: ${msg}` };
		}
	},
};

export { buildToolEnv, truncateUtf8 };
