import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AI_AGENT_NAME } from "./agent-environment.js";
import {
	gitCommitAttributionEnabled,
	reportCommitAttributionDiagnostic,
	withManagedGitCommitAttributionEnvironment,
} from "./git-commit-attribution.js";
import { clampTimerDelayMs } from "./timers.js";

export { clampTimerDelayMs as clampTimeoutMs } from "./timers.js";

// Hard memory-safety ceiling for a single command's captured output. This is
// deliberately far above any display cap (see BASH_DISPLAY_MAX_BYTES in
// bash.ts, ~16 KB): output is retained and spilled to an offload file up to
// this bound, and only a runaway command that blows past it gets the child
// killed. Never truncate merely because the *display* cap was hit — the tail
// (failing assertion, compiler error, exit summary) must survive.
export const BASH_HARD_CAP_BYTES = 16 * 1024 * 1024;

const CLIO_CONTROL_ENV_KEYS = ["CLIO_CODER_INTERACTIVE"] as const;

export interface BashCommandResult {
	error: NodeJS.ErrnoException | null;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	timedOut: boolean;
	outputCapped: boolean;
	/** Exact bytes retained from stdout and stderr, never above the hard cap. */
	outputBytes: number;
}

export interface BashCommandProgress {
	/** Cumulative stdout captured so far. */
	stdout: string;
	/** Cumulative stderr captured so far. */
	stderr: string;
	/** Total bytes accepted from both streams so far. */
	outputBytes: number;
}

export interface RunBashCommandOptions {
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Cumulative snapshots, throttled to keep terminal rendering responsive. */
	onUpdate?: (progress: BashCommandProgress) => void;
}

const BASH_UPDATE_THROTTLE_MS = 100;

export interface BashProgressScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}

export interface BashOutputProgressController {
	/** Emit the initial empty cumulative snapshot, when a callback is configured. */
	start(): void;
	/** Accept one stream chunk. Returns true only when this chunk reaches the hard cap. */
	append(target: "stdout" | "stderr", chunk: Buffer): boolean;
	/** Seal output, cancel progress work, emit the final snapshot, and return the result fields. */
	settle(): Pick<BashCommandResult, "stdout" | "stderr" | "outputBytes" | "outputCapped">;
}

const SYSTEM_PROGRESS_SCHEDULER: BashProgressScheduler = {
	now: Date.now,
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Cumulative stdout/stderr fold shared by the child stream handlers and a
 * deterministic contract-test seam. Settlement is a phase, not just a final
 * boolean: once it starts, re-entrant or queued stream work is rejected while
 * the one final advisory snapshot is still allowed to publish.
 */
export function createBashOutputProgressController(
	onUpdate?: (progress: BashCommandProgress) => void,
	scheduler: BashProgressScheduler = SYSTEM_PROGRESS_SCHEDULER,
): BashOutputProgressController {
	let phase: "active" | "settling" | "settled" = "active";
	let stdout = "";
	let stderr = "";
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let decodersFinished = false;
	let outputBytes = 0;
	let outputCapped = false;
	let updateTimer: unknown = null;
	let updateDirty = false;
	let lastUpdateAt = 0;

	const snapshot = (): BashCommandProgress => ({ stdout, stderr, outputBytes });

	const finishDecoders = (): void => {
		if (decodersFinished) return;
		decodersFinished = true;
		// A hard byte cap may bisect a multibyte code point. Discard the
		// decoder's incomplete suffix instead of manufacturing U+FFFD.
		if (outputCapped) return;
		stdout += stdoutDecoder.end();
		stderr += stderrDecoder.end();
	};

	const emitUpdate = (final = false): void => {
		if (onUpdate === undefined || !updateDirty) return;
		if (phase !== "active" && !(final && phase === "settling")) return;
		updateDirty = false;
		lastUpdateAt = scheduler.now();
		try {
			onUpdate(snapshot());
		} catch {
			// Rendering progress is advisory and must never change command execution.
		}
	};

	const clearUpdateTimer = (): void => {
		if (updateTimer === null) return;
		scheduler.clearTimeout(updateTimer);
		updateTimer = null;
	};

	const scheduleUpdate = (): void => {
		if (onUpdate === undefined || phase !== "active") return;
		updateDirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (scheduler.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitUpdate();
			return;
		}
		updateTimer ??= scheduler.setTimeout(() => {
			updateTimer = null;
			// A timer already queued by the event loop may still invoke its callback
			// after clearTimeout. The phase check makes that callback inert.
			emitUpdate();
		}, delay);
	};

	return {
		start(): void {
			if (phase !== "active" || onUpdate === undefined) return;
			updateDirty = true;
			emitUpdate();
		},
		append(target, chunk): boolean {
			if (phase !== "active" || outputCapped) return false;
			const remaining = BASH_HARD_CAP_BYTES - outputBytes;
			const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
			outputBytes += accepted.byteLength;
			if (accepted.byteLength > 0) {
				const decoded = target === "stdout" ? stdoutDecoder.write(accepted) : stderrDecoder.write(accepted);
				if (target === "stdout") stdout += decoded;
				else stderr += decoded;
			}
			if (accepted.byteLength < chunk.byteLength) outputCapped = true;
			scheduleUpdate();
			return outputCapped;
		},
		settle() {
			if (phase === "settled") return { ...snapshot(), outputCapped };
			if (phase === "settling") return { ...snapshot(), outputCapped };
			phase = "settling";
			clearUpdateTimer();
			finishDecoders();
			emitUpdate(true);
			phase = "settled";
			return { ...snapshot(), outputCapped };
		},
	};
}

function buildToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	env.AI_AGENT = AI_AGENT_NAME;
	for (const key of CLIO_CONTROL_ENV_KEYS) {
		Reflect.deleteProperty(env, key);
	}
	return env;
}

// Login-profile sourcing is the dominant per-call spawn overhead: `-l`
// re-reads /etc/profile and the user's profile chain on EVERY call (~10ms on
// a lean profile, hundreds of ms with nvm/conda in it). The profile exists to
// shape the environment, so capture that environment once per process and
// spawn every subsequent command as a plain `bash -c` with the snapshot. Each
// call still gets a fresh shell — only the env composition is cached, so
// there is no state bleed and cancellation semantics are untouched. When the
// capture fails (profile error, timeout, no PATH), every call falls back to
// the historical per-call `-lc`.
const LOGIN_ENV_CAPTURE_TIMEOUT_MS = 10_000;

let loginEnvCapture: Promise<NodeJS.ProcessEnv | null> | null = null;

/** NUL-delimited `env -0` output to an env map; null when unusable (no PATH). */
function parseNullDelimitedEnv(raw: string): NodeJS.ProcessEnv | null {
	const env: NodeJS.ProcessEnv = {};
	for (const entry of raw.split("\0")) {
		if (entry.length === 0) continue;
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		env[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return typeof env.PATH === "string" && env.PATH.length > 0 ? env : null;
}

function captureLoginEnv(): Promise<NodeJS.ProcessEnv | null> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const finish = (value: NodeJS.ProcessEnv | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const child = spawn("/bin/bash", ["-lc", "env -0"], {
			env: buildToolEnv(),
			stdio: ["ignore", "pipe", "ignore"],
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, LOGIN_ENV_CAPTURE_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code === 0 ? parseNullDelimitedEnv(stdout) : null));
	});
}

interface BashSpawnPlan {
	mode: "-c" | "-lc";
	env: NodeJS.ProcessEnv;
}

async function bashSpawnPlan(): Promise<BashSpawnPlan> {
	loginEnvCapture ??= captureLoginEnv();
	const captured = await loginEnvCapture;
	if (captured === null) return { mode: "-lc", env: buildToolEnv() };
	// Captured (login-transformed) values win; keys added to process.env after
	// the capture still flow through; the CLIO control keys are re-stripped
	// last so they never reach the child from either source.
	const env: NodeJS.ProcessEnv = { ...process.env, ...captured };
	env.AI_AGENT = AI_AGENT_NAME;
	for (const key of CLIO_CONTROL_ENV_KEYS) {
		Reflect.deleteProperty(env, key);
	}
	return { mode: "-c", env };
}

export function combineBashOutput(result: Pick<BashCommandResult, "stdout" | "stderr">): string {
	const { stdout, stderr } = result;
	return stderr.length > 0 ? `${stdout}${stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n"}${stderr}` : stdout;
}

export async function runBashCommand(command: string, options: RunBashCommandOptions = {}): Promise<BashCommandResult> {
	const plan = await bashSpawnPlan();
	const attribution = withManagedGitCommitAttributionEnvironment(plan.env, {
		cwd: options.cwd ?? process.cwd(),
		enabled: gitCommitAttributionEnabled(process.env),
	});
	reportCommitAttributionDiagnostic(attribution.diagnostic);
	return new Promise((resolve) => {
		const timeout = clampTimerDelayMs(options.timeoutMs ?? 300_000);
		let aborted = false;
		let timedOut = false;
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let killGraceTimer: ReturnType<typeof setTimeout> | null = null;
		let killSent = false;
		const output = createBashOutputProgressController(options.onUpdate);

		const child = spawn("/bin/bash", [plan.mode, command], {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			env: attribution.env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		output.start();

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

		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		const appendChunk = (target: "stdout" | "stderr", chunk: Buffer): void => {
			if (output.append(target, chunk)) killChild();
		};

		child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			clearKillGraceTimer();
			const finalOutput = output.settle();
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				error: error as NodeJS.ErrnoException,
				...finalOutput,
				exitCode: null,
				signal: null,
				aborted,
				timedOut,
			});
		});
		child.on("close", (code, signalName) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			clearKillGraceTimer();
			const finalOutput = output.settle();
			options.signal?.removeEventListener("abort", onAbort);
			const error =
				code === 0 && signalName === null
					? null
					: ({
							name: "Error",
							message: signalName ? `command terminated by ${signalName}` : `command exited with code ${code ?? "?"}`,
							code: code ?? undefined,
							signal: signalName ?? undefined,
						} as NodeJS.ErrnoException);
			resolve({
				error,
				...finalOutput,
				exitCode: code,
				signal: signalName,
				aborted,
				timedOut,
			});
		});
	});
}
