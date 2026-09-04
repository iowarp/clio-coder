import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { AutonomyLevel } from "../../domains/safety/autonomy.js";
import { assertToolProfileEnforceable } from "../../tools/profiles.js";
import { readStderr, waitForClose } from "../external-subprocess.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";

/** Official CLI binary, resolved from the user's PATH. */
const ANTIGRAVITY_BINARY = "agy";
const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024;

type AntigravityChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type AntigravityUsage = {
	input_tokens?: unknown;
	output_tokens?: unknown;
	thinking_tokens?: unknown;
	cache_read_tokens?: unknown;
	total_tokens?: unknown;
};

type AntigravityResult = {
	conversation_id?: unknown;
	status?: unknown;
	response?: unknown;
	error?: unknown;
	usage?: unknown;
};

export type AntigravityStreamEvent =
	| { event: "init"; conversationId: string | null }
	| { event: "text"; conversationId: string | null; delta: string }
	| { event: "result"; result: AntigravityResult }
	| { event: "other" };

export interface AntigravitySubprocessConfig {
	extraArgs: string[];
	dangerousBypass: boolean;
	externalMode: "plan+sandbox" | "accept-edits" | "bypassPermissions";
}

/**
 * Translate Clio's enforced autonomy ceiling to the official CLI's coarser
 * headless modes. Every non-bypass launch is explicit, so a user's changing
 * interactive `agy` defaults cannot silently widen a delegated run.
 */
export function antigravitySubprocessConfigForAutonomy(
	level: AutonomyLevel | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AntigravitySubprocessConfig {
	if (level === "full-auto" && env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS === "1") {
		return {
			extraArgs: ["--dangerously-skip-permissions"],
			dangerousBypass: true,
			externalMode: "bypassPermissions",
		};
	}
	if (level === "suggest") {
		throw new Error(
			"antigravity-code runtime cannot enforce autonomy 'suggest': it cannot park tool calls for approval. Dispatch to a native or claude-sdk worker, or use read-only or auto-edit.",
		);
	}
	if (level === "read-only") {
		return { extraArgs: ["--mode", "plan", "--sandbox"], dangerousBypass: false, externalMode: "plan+sandbox" };
	}
	// Both auto-edit and an ungated full-auto request stay at agy's explicit
	// accept-edits ceiling. Shell and network policy remain owned by agy.
	return { extraArgs: ["--mode", "accept-edits"], dangerousBypass: false, externalMode: "accept-edits" };
}

function buildAntigravityPrompt(input: WorkerRunInput): string {
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
	assertToolProfileEnforceable(input.toolProfile, "antigravity-code");
	const permission = antigravitySubprocessConfigForAutonomy(input.autonomy);
	const args = [...permission.extraArgs, "--output-format", "stream-json", "--disable-slash-commands"];
	if (input.wireModelId.trim().length > 0) args.push("--model", input.wireModelId.trim());
	args.push("--print", buildAntigravityPrompt(input));
	return args;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Parse one event from agy's newline-delimited `stream-json` output. */
export function parseAntigravityStreamLine(line: string): AntigravityStreamEvent | null {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return null;
	}
	const envelope = record(decoded);
	if (!envelope || typeof envelope.event !== "string") return null;
	if (envelope.event === "init") {
		return {
			event: "init",
			conversationId: typeof envelope.conversation_id === "string" ? envelope.conversation_id : null,
		};
	}
	if (envelope.event === "step_update") {
		const update = record(envelope.step_update);
		if (!update) return null;
		if (update.step_type !== "agent_response" || typeof update.text_delta !== "string") {
			return { event: "other" };
		}
		return {
			event: "text",
			conversationId: typeof update.conversation_id === "string" ? update.conversation_id : null,
			delta: update.text_delta,
		};
	}
	if (envelope.event === "result") {
		const result = record(envelope.result);
		return result ? { event: "result", result } : null;
	}
	return { event: "other" };
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeUsage(raw: unknown): Usage {
	const source = (record(raw) ?? {}) as AntigravityUsage;
	const input = finite(source.input_tokens);
	const output = finite(source.output_tokens);
	const cacheRead = finite(source.cache_read_tokens);
	const reasoningTokens = finite(source.thinking_tokens);
	const usage: Usage & { reasoningTokens?: number } = {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: finite(source.total_tokens) || input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (reasoningTokens > 0) usage.reasoningTokens = reasoningTokens;
	return usage;
}

function resultError(
	result: AntigravityResult | null,
	stderr: string,
	missingResult: boolean,
	malformedLines: number,
): string {
	if (typeof result?.error === "string" && result.error.trim()) return result.error.trim();
	if (missingResult) {
		return "Antigravity CLI ended without a terminal stream result. Update `agy` and verify it supports `--output-format stream-json`.";
	}
	if (malformedLines > 0) {
		return `Antigravity CLI emitted ${malformedLines} unreadable structured output line${malformedLines === 1 ? "" : "s"}; update \`agy\` and retry.`;
	}
	return stderr.trim();
}

function buildAssistantMessage(input: {
	model: string;
	text: string;
	result: AntigravityResult | null;
	conversationId: string | null;
	exitCode: number;
	aborted: boolean;
	stderr: string;
	malformedLines: number;
}): AgentMessage & { role: "assistant" } {
	const resultSucceeded = input.result?.status === "SUCCESS";
	const missingResult = input.result === null;
	const failed = input.exitCode !== 0 || !resultSucceeded || input.malformedLines > 0;
	const errorMessage = failed ? resultError(input.result, input.stderr, missingResult, input.malformedLines) : "";
	const message: AgentMessage & { role: "assistant" } = {
		role: "assistant",
		content: [{ type: "text", text: input.text }],
		api: "google-generative-ai",
		provider: "google",
		model: input.model,
		usage: normalizeUsage(input.result?.usage),
		stopReason: input.aborted ? "aborted" : failed ? "error" : "stop",
		timestamp: Date.now(),
	} as AgentMessage & { role: "assistant" };
	if (input.conversationId) message.responseId = input.conversationId;
	if (errorMessage) message.errorMessage = errorMessage;
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
		result: { status: "SUCCESS" },
		conversationId: null,
		exitCode: 0,
		aborted: false,
		stderr: "",
		malformedLines: 0,
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

async function readStream(
	child: AntigravityChildProcess,
	emit: WorkerEventEmit,
	state: {
		started: boolean;
		text: string;
		model: string;
		result: AntigravityResult | null;
		conversationId: string | null;
		malformedLines: number;
	},
): Promise<void> {
	const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of lines) {
		if (Buffer.byteLength(line) > MAX_STREAM_LINE_BYTES) {
			state.malformedLines += 1;
			continue;
		}
		const event = parseAntigravityStreamLine(line);
		if (!event) {
			if (line.trim()) state.malformedLines += 1;
			continue;
		}
		if (event.event === "init") state.conversationId = event.conversationId ?? state.conversationId;
		if (event.event === "text") {
			state.conversationId = event.conversationId ?? state.conversationId;
			emitTextDelta(emit, state, event.delta);
		}
		if (event.event === "result") {
			state.result = event.result;
			if (typeof event.result.conversation_id === "string") state.conversationId = event.result.conversation_id;
		}
	}
}

export function startAntigravityWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const args = buildAgyArgs(input);
	const child = spawn(ANTIGRAVITY_BINARY, args, {
		cwd: input.cwd ?? process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const streamState = {
		started: false,
		text: "",
		model: input.wireModelId,
		result: null as AntigravityResult | null,
		conversationId: null as string | null,
		malformedLines: 0,
	};
	let aborted = false;
	let spawnError = "";
	let killTimer: NodeJS.Timeout | null = null;

	const abort = (): void => {
		aborted = true;
		if (child.exitCode !== null) return;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 1500);
	};
	const onAbort = (): void => abort();
	if (input.signal) {
		if (input.signal.aborted) abort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}
	child.once("error", (cause) => {
		spawnError =
			(cause as NodeJS.ErrnoException).code === "ENOENT"
				? "Antigravity CLI (`agy`) is not installed or not on PATH."
				: cause.message;
	});

	const promise = (async (): Promise<WorkerRunResult> => {
		emit({ type: "agent_start" } as AgentEvent);
		const stderrPromise = readStderr(child);
		const stdoutPromise = readStream(child, emit, streamState);
		const exitCode = await waitForClose(child);
		await stdoutPromise.catch((cause) => {
			spawnError ||= cause instanceof Error ? cause.message : String(cause);
		});
		const stderr = await stderrPromise.catch(() => "");
		if (killTimer) clearTimeout(killTimer);
		input.signal?.removeEventListener("abort", onAbort);
		const resultText = typeof streamState.result?.response === "string" ? streamState.result.response : "";
		const finalText = resultText || streamState.text || (exitCode === 0 ? "" : spawnError || stderr.trim());
		const effectiveStderr = spawnError || stderr;
		const finalMessage = buildAssistantMessage({
			model: streamState.model,
			text: finalText,
			result: streamState.result,
			conversationId: streamState.conversationId,
			exitCode,
			aborted,
			stderr: effectiveStderr,
			malformedLines: streamState.malformedLines,
		});
		if (!streamState.started) emit({ type: "message_start", message: finalMessage } as AgentEvent);
		emit({ type: "message_end", message: finalMessage } as AgentEvent);
		const messages: AgentMessage[] = [finalMessage];
		emit({ type: "agent_end", messages } as AgentEvent);
		if (finalMessage.stopReason === "error" && effectiveStderr.trim() && !aborted) {
			process.stderr.write(`[worker:antigravity-code] ${effectiveStderr.trim()}\n`);
		}
		return { messages, exitCode: finalMessage.stopReason === "stop" ? 0 : 1 };
	})();

	return { promise, abort };
}
