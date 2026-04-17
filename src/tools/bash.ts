import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const MAX_OUTPUT_BYTES = 1_000_000;
const TRUNCATION_MARKER = "\n[output truncated]\n";

function truncate(text: string): string {
	return truncateUtf8(text, MAX_OUTPUT_BYTES, TRUNCATION_MARKER);
}

interface ExecOutcome {
	error: NodeJS.ErrnoException | null;
	stdout: string;
	stderr: string;
}

function execBash(command: string, cwd: string | undefined, timeout: number): Promise<ExecOutcome> {
	return new Promise((resolve) => {
		execFile(
			"/bin/bash",
			["-lc", command],
			{ cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES * 2, encoding: "utf8" },
			(error, stdout, stderr) => {
				resolve({
					error: error as NodeJS.ErrnoException | null,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			},
		);
	});
}

export const bashTool: ToolSpec = {
	name: ToolNames.Bash,
	description: "Execute a shell command via /bin/bash -lc. Captures stdout and stderr.",
	parameters: Type.Object(
		{
			command: Type.String({ description: "Shell command to run. Piped into bash -lc." }),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the command. Defaults to the orchestrator cwd." }),
			),
			timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 60000. Must be > 0." })),
		},
		{ additionalProperties: false },
	),
	baseActionClass: "execute",
	async run(args): Promise<ToolResult> {
		if (typeof args.command !== "string" || args.command.length === 0) {
			return { kind: "error", message: "bash: missing command argument" };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
		const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 60_000;
		try {
			const { error, stdout, stderr } = await execBash(args.command, cwd, timeout);
			if (error) {
				const code = typeof error.code === "number" ? error.code : (error as { code?: string }).code;
				const tail = stderr.length > 0 ? stderr : stdout;
				const message = `bash: command failed (exit ${code ?? "?"}): ${truncate(tail).trim() || error.message}`;
				return { kind: "error", message };
			}
			const combined =
				stderr.length > 0 ? `${stdout}${stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n"}${stderr}` : stdout;
			return { kind: "ok", output: truncate(combined) };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `bash: ${msg}` };
		}
	},
};

export { truncateUtf8 };
