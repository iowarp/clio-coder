import { spawn } from "node:child_process";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const MAX_OUTPUT_BYTES = 1_000_000;
const TRUNCATION_MARKER = "\n[output truncated]\n";
const CLIO_CONTROL_ENV_KEYS = ["CLIO_DEV", "CLIO_SELF_DEV", "CLIO_INTERACTIVE", "CLIO_RESUME_SESSION_ID"] as const;

function truncate(text: string): string {
	return truncateUtf8(text, MAX_OUTPUT_BYTES, TRUNCATION_MARKER);
}

interface ExecOutcome {
	error: NodeJS.ErrnoException | null;
	stdout: string;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
	outputCapped: boolean;
}

function buildToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of CLIO_CONTROL_ENV_KEYS) {
		Reflect.deleteProperty(env, key);
	}
	return env;
}

function execBash(
	command: string,
	cwd: string | undefined,
	timeout: number,
	signal?: AbortSignal,
): Promise<ExecOutcome> {
	return new Promise((resolve) => {
		let aborted = false;
		let timedOut = false;
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let killGraceTimer: ReturnType<typeof setTimeout> | null = null;
		let killSent = false;
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let outputCapped = false;

		const child = spawn("/bin/bash", ["-lc", command], {
			cwd,
			env: buildToolEnv(),
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const clearKillGraceTimer = (): void => {
			if (!killGraceTimer) return;
			clearTimeout(killGraceTimer);
			killGraceTimer = null;
		};

		const sendSignal = (signalName: NodeJS.Signals): void => {
			const pid = child.pid;
			if (pid && process.platform !== "win32") {
				try {
					process.kill(-pid, signalName);
					return;
				} catch {
					// Fall through to killing the shell process directly.
				}
			}
			child.kill(signalName);
		};

		const killChild = (): void => {
			if (killSent) return;
			killSent = true;
			sendSignal("SIGTERM");
			killGraceTimer = setTimeout(() => {
				sendSignal("SIGKILL");
			}, 5000);
		};

		function onAbort(): void {
			aborted = true;
			killChild();
		}

		if (timeout > 0) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				killChild();
			}, timeout);
		}

		if (signal?.aborted) {
			onAbort();
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
		}

		const appendChunk = (target: "stdout" | "stderr", chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > MAX_OUTPUT_BYTES * 2) {
				outputCapped = true;
				killChild();
				return;
			}
			if (outputCapped) return;
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};

		child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			clearKillGraceTimer();
			signal?.removeEventListener("abort", onAbort);
			resolve({ error: error as NodeJS.ErrnoException, stdout, stderr, aborted, timedOut, outputCapped });
		});
		child.on("close", (code, signalName) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			clearKillGraceTimer();
			signal?.removeEventListener("abort", onAbort);
			const error =
				code === 0 && signalName === null
					? null
					: ({
							name: "Error",
							message: signalName ? `command terminated by ${signalName}` : `command exited with code ${code ?? "?"}`,
							code: code ?? undefined,
							signal: signalName ?? undefined,
						} as NodeJS.ErrnoException);
			resolve({ error, stdout, stderr, aborted, timedOut, outputCapped });
		});
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
	executionMode: "sequential",
	async run(args, options): Promise<ToolResult> {
		if (typeof args.command !== "string" || args.command.length === 0) {
			return { kind: "error", message: "bash: missing command argument" };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
		const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 60_000;
		try {
			const { error, stdout, stderr, aborted, timedOut, outputCapped } = await execBash(
				args.command,
				cwd,
				timeout,
				options?.signal,
			);
			if (aborted) {
				return { kind: "error", message: "bash: command aborted" };
			}
			if (timedOut) {
				return { kind: "error", message: `bash: command timed out after ${timeout}ms` };
			}
			if (outputCapped) {
				return { kind: "error", message: `bash: command output exceeded ${MAX_OUTPUT_BYTES * 2} bytes` };
			}
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

export { buildToolEnv, truncateUtf8 };
