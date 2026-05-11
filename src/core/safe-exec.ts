import { spawn } from "node:child_process";
import path from "node:path";

export const SAFE_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 600_000;

const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"CI",
	"NO_COLOR",
] as const;

export interface SafeCommandResult {
	file: string;
	args: string[];
	cwd: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	timedOut: boolean;
	outputCapped: boolean;
	durationMs: number;
}

export interface RunCommandVectorOptions {
	cwd?: string;
	workspaceRoot?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
	env?: Record<string, string>;
}

export function buildSafeToolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(extra)) {
		if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
		env[key] = value;
	}
	return env;
}

export function resolveSafeCwd(cwd: string | undefined, workspaceRoot: string = process.cwd()): string {
	const root = path.resolve(workspaceRoot);
	const resolved = cwd === undefined ? root : path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(root, cwd);
	const rel = path.relative(root, resolved);
	if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
	throw new Error(`cwd escapes workspace root: ${resolved}`);
}

export function runCommandVector(
	file: string,
	args: ReadonlyArray<string>,
	options: RunCommandVectorOptions = {},
): Promise<SafeCommandResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = resolveSafeCwd(options.cwd, options.workspaceRoot);
		const timeoutMs = options.timeoutMs ?? SAFE_EXEC_DEFAULT_TIMEOUT_MS;
		const maxOutputBytes = options.maxOutputBytes ?? SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
		let aborted = false;
		let timedOut = false;
		let outputCapped = false;
		let outputBytes = 0;
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killSent = false;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let killGraceTimer: ReturnType<typeof setTimeout> | null = null;

		const child = spawn(file, [...args], {
			cwd,
			env: buildSafeToolEnv(options.env),
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const clearKillGraceTimer = (): void => {
			if (killGraceTimer) clearTimeout(killGraceTimer);
			killGraceTimer = null;
		};

		const sendSignal = (signalName: NodeJS.Signals): void => {
			const pid = child.pid;
			if (pid && process.platform !== "win32") {
				try {
					process.kill(-pid, signalName);
					return;
				} catch {
					// Fall through to killing the direct child.
				}
			}
			child.kill(signalName);
		};

		const killChild = (): void => {
			if (killSent) return;
			killSent = true;
			sendSignal("SIGTERM");
			killGraceTimer = setTimeout(() => sendSignal("SIGKILL"), 3000);
		};

		const onAbort = (): void => {
			aborted = true;
			killChild();
		};

		if (timeoutMs > 0) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				killChild();
			}, timeoutMs);
		}
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		const appendChunk = (target: "stdout" | "stderr", chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				outputCapped = true;
				killChild();
				return;
			}
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
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				file,
				args: [...args],
				cwd,
				stdout,
				stderr: stderr.length > 0 ? stderr : error.message,
				exitCode: null,
				signal: null,
				aborted,
				timedOut,
				outputCapped,
				durationMs: Date.now() - startedAt,
			});
		});
		child.on("close", (code, signalName) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			clearKillGraceTimer();
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				file,
				args: [...args],
				cwd,
				stdout,
				stderr,
				exitCode: code,
				signal: signalName,
				aborted,
				timedOut,
				outputCapped,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

export function combineSafeOutput(result: Pick<SafeCommandResult, "stdout" | "stderr">): string {
	const { stdout, stderr } = result;
	return stderr.length > 0 ? `${stdout}${stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n"}${stderr}` : stdout;
}
