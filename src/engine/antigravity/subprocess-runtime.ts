import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type { AutonomyLevel } from "../../domains/safety/autonomy.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";

/** Binary name; resolved via PATH like the `claude` runner resolves `claude`. */
const ANTIGRAVITY_BINARY = "agy";

type AntigravityChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface AntigravitySubprocessConfig {
	extraArgs: string[];
	dangerousBypass: boolean;
}

/**
 * agy `--print` permission flags for a given autonomy level, mirroring the
 * Claude Code runner's posture against agy's coarser flag surface (agy exposes
 * only `--sandbox` and `--dangerously-skip-permissions`; it has no per-tool
 * allowlist or accept-edits mode).
 *
 *  - `full-auto` + `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` opens the dangerous
 *    bypass (`--dangerously-skip-permissions`); nothing else does.
 *  - `read-only` and `suggest` run `--sandbox` (terminal restrictions; the
 *    closest headless analog, since `agy --print` cannot pause to ask).
 *  - `auto-edit` and ungated `full-auto` pass no permission flag and defer to
 *    agy's own `settings.json`.
 */
export function antigravitySubprocessConfigForAutonomy(
	level: AutonomyLevel | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AntigravitySubprocessConfig {
	if (level === "full-auto" && env.CLIO_ALLOW_EXTERNAL_FULL_ACCESS === "1") {
		return { extraArgs: ["--dangerously-skip-permissions"], dangerousBypass: true };
	}
	if (level === "read-only" || level === "suggest") {
		return { extraArgs: ["--sandbox"], dangerousBypass: false };
	}
	return { extraArgs: [], dangerousBypass: false };
}

export function buildAntigravityPrompt(input: WorkerRunInput): string {
	const parts: string[] = [];
	const systemPrompt = input.systemPrompt.trim();
	if (systemPrompt.length > 0) parts.push(systemPrompt);
	for (const message of input.dynamicPromptMessages ?? []) {
		const body = message.body.trim();
		if (body.length > 0) parts.push(body);
	}
	parts.push(input.task);
	return parts.join("\n\n");
}

export function buildAgyArgs(input: WorkerRunInput): string[] {
	const permission = antigravitySubprocessConfigForAutonomy(input.autonomy);
	const args = ["--print", ...permission.extraArgs];
	if (input.wireModelId.trim().length > 0) args.push("--model", input.wireModelId.trim());
	args.push(buildAntigravityPrompt(input));
	return args;
}

function buildAssistantMessage(input: {
	model: string;
	text: string;
	exitCode: number;
	aborted: boolean;
	stderr: string;
}): AgentMessage & { role: "assistant" } {
	const message: AgentMessage & { role: "assistant" } = {
		role: "assistant",
		content: [{ type: "text", text: input.text }],
		api: "google-generative-ai",
		provider: "google",
		model: input.model,
		usage: ZERO_USAGE,
		stopReason: input.aborted ? "aborted" : input.exitCode === 0 ? "stop" : "error",
		timestamp: Date.now(),
	} as AgentMessage & { role: "assistant" };
	if (input.exitCode !== 0 && !input.aborted) {
		const detail = input.stderr.trim();
		if (detail.length > 0) message.errorMessage = detail;
	}
	return message;
}

function emitTextDelta(
	emit: WorkerEventEmit,
	state: { started: boolean; text: string; model: string },
	delta: string,
): void {
	if (delta.length === 0) return;
	state.text += delta;
	const message = buildAssistantMessage({
		model: state.model,
		text: state.text,
		exitCode: 0,
		aborted: false,
		stderr: "",
	});
	if (!state.started) {
		state.started = true;
		emit({ type: "message_start", message } as AgentEvent);
	}
	emit({
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: message,
		},
	} as AgentEvent);
}

async function readStdout(
	child: AntigravityChildProcess,
	emit: WorkerEventEmit,
	state: { started: boolean; text: string; model: string },
): Promise<void> {
	for await (const chunk of child.stdout) {
		emitTextDelta(emit, state, String(chunk));
	}
}

async function readStderr(child: AntigravityChildProcess): Promise<string> {
	let stderr = "";
	for await (const chunk of child.stderr) {
		stderr += String(chunk);
		if (stderr.length > 8192) stderr = stderr.slice(-8192);
	}
	return stderr;
}

function waitForClose(child: AntigravityChildProcess): Promise<number> {
	return new Promise((resolve) => {
		child.once("error", () => resolve(1));
		child.once("close", (code) => resolve(code ?? 1));
	});
}

export function startAntigravityWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const args = buildAgyArgs(input);
	const child = spawn(ANTIGRAVITY_BINARY, args, {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const streamState = { started: false, text: "", model: input.wireModelId };
	let aborted = false;
	let killTimer: NodeJS.Timeout | null = null;

	const abort = (): void => {
		aborted = true;
		if (child.killed) return;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 1500);
	};
	if (input.signal) {
		if (input.signal.aborted) abort();
		else input.signal.addEventListener("abort", abort, { once: true });
	}

	const promise = (async (): Promise<WorkerRunResult> => {
		emit({ type: "agent_start" } as AgentEvent);
		const stderrPromise = readStderr(child);
		const stdoutPromise = readStdout(child, emit, streamState);
		const exitCode = await waitForClose(child);
		await stdoutPromise.catch(() => {});
		const stderr = await stderrPromise.catch(() => "");
		if (killTimer) clearTimeout(killTimer);
		const finalText = streamState.text || (exitCode === 0 ? "" : stderr.trim());
		const finalMessage = buildAssistantMessage({
			model: streamState.model,
			text: finalText,
			exitCode,
			aborted,
			stderr,
		});
		if (!streamState.started) emit({ type: "message_start", message: finalMessage } as AgentEvent);
		emit({ type: "message_end", message: finalMessage } as AgentEvent);
		const messages: AgentMessage[] = [finalMessage];
		emit({ type: "agent_end", messages } as AgentEvent);
		if (exitCode !== 0 && stderr.trim().length > 0 && !aborted) {
			process.stderr.write(`[worker:antigravity-code] ${stderr.trim()}\n`);
		}
		return { messages, exitCode: exitCode === 0 ? 0 : 1 };
	})();

	return {
		promise,
		abort,
		steer(_text: string) {
			// `agy --print` is a single-shot subprocess and does not surface a
			// resumable conversation id on stdout, so there is nothing to steer.
		},
	};
}
