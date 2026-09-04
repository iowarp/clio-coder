import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { buildSafeToolEnv, resolveSafeCwd } from "../../core/safe-exec.js";
import type { AutonomyLevel } from "../../domains/safety/autonomy.js";
import { assertToolProfileEnforceable } from "../../tools/profiles.js";
import { createProcessTreeTerminator, readBoundedLines, readStderr, waitForClose } from "../external-subprocess.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";

/** Official CLI binary, resolved from the operator's PATH. */
const ANTIGRAVITY_BINARY = "agy";
export const ANTIGRAVITY_MAX_STREAM_LINE_BYTES = 1024 * 1024;
export const ANTIGRAVITY_MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const ANTIGRAVITY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const ANTIGRAVITY_MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOL_DIAGNOSTICS = 32;
const MAX_CONVERSATION_ID_BYTES = 4096;

type AntigravityChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

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
	| { event: "init"; conversationId: string | null; model: string | null }
	| { event: "text"; conversationId: string | null; delta: string }
	| { event: "result"; result: AntigravityResult }
	| { event: "other" };

export interface AntigravitySubprocessConfig {
	extraArgs: string[];
	dangerousBypass: boolean;
	externalMode: "plan+sandbox" | "accept-edits" | "bypassPermissions";
}

export interface AntigravityRuntimeDependencies {
	binary?: string;
	workspaceRoot?: string;
	environment?: NodeJS.ProcessEnv;
	killGraceMs?: number;
	spawnProcess?: (
		file: string,
		args: ReadonlyArray<string>,
		options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["pipe", "pipe", "pipe"] },
	) => AntigravityChildProcess;
}

/**
 * Translate Clio's effective autonomy ceiling to the official CLI's coarser
 * modes. Every non-bypass launch is explicit, so changing interactive `agy`
 * defaults cannot silently widen a delegated run.
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
	// Both auto-edit and ungated full-auto stay at agy's explicit
	// accept-edits ceiling. Shell/network policy remains owned by agy.
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

/** Official one-turn stream-json stdin record. JSON encoding keeps prompt text literal. */
export function buildAgyStdinLine(input: WorkerRunInput): string {
	const content = buildAntigravityPrompt(input);
	if (Buffer.byteLength(content, "utf8") > ANTIGRAVITY_MAX_PROMPT_BYTES) {
		throw new Error(`Antigravity work order exceeded ${ANTIGRAVITY_MAX_PROMPT_BYTES} bytes`);
	}
	return `${JSON.stringify({ event: "user", message: { content } })}\n`;
}

export function buildAgyArgs(input: WorkerRunInput, gateEnv: NodeJS.ProcessEnv = process.env): string[] {
	assertToolProfileEnforceable(input.toolProfile, "antigravity-code");
	const permission = antigravitySubprocessConfigForAutonomy(input.autonomy, gateEnv);
	const args = [
		...permission.extraArgs,
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--disable-slash-commands",
	];
	if (input.wireModelId.trim().length > 0) args.push("--model", input.wireModelId.trim());
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
			model: typeof envelope.model === "string" ? envelope.model : null,
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
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
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
		totalTokens: finite(source.total_tokens) || input + output + reasoningTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (reasoningTokens > 0) usage.reasoningTokens = reasoningTokens;
	return usage;
}

function appendBoundedText(current: string, delta: string): string {
	if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(delta, "utf8") > ANTIGRAVITY_MAX_RESPONSE_BYTES) {
		throw new Error(`Antigravity response exceeded ${ANTIGRAVITY_MAX_RESPONSE_BYTES} bytes`);
	}
	return current + delta;
}

function boundedProviderField(value: unknown, field: string): string {
	if (typeof value !== "string") return "";
	if (Buffer.byteLength(value, "utf8") > ANTIGRAVITY_MAX_RESPONSE_BYTES) {
		throw new Error(`Antigravity terminal ${field} exceeded ${ANTIGRAVITY_MAX_RESPONSE_BYTES} bytes`);
	}
	return value;
}

function boundedConversationId(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	return Buffer.byteLength(value, "utf8") <= MAX_CONVERSATION_ID_BYTES ? value : null;
}

interface StreamState {
	started: boolean;
	text: string;
	model: string;
	result: AntigravityResult | null;
	conversationId: string | null;
	initSeen: boolean;
	terminalSeen: boolean;
	protocolDiagnostics: string[];
}

function protocolFailure(state: StreamState, detail: string): void {
	if (state.protocolDiagnostics.length < MAX_PROTOCOL_DIAGNOSTICS) state.protocolDiagnostics.push(detail);
}

function emitTextDelta(emit: WorkerEventEmit, state: StreamState, delta: string): void {
	if (delta.length === 0) return;
	state.text = appendBoundedText(state.text, delta);
	if (!state.started) {
		state.started = true;
		emit({
			type: "message_start",
			message: buildAssistantMessage({
				model: state.model,
				text: "",
				result: null,
				conversationId: null,
				exitCode: 0,
				aborted: false,
				diagnostic: "",
			}),
		} as AgentEvent);
	}
	// This runner is worker-only. The NDJSON event contract consumes the delta;
	// cumulative message/partial copies are intentionally omitted.
	emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	} as AgentEvent);
}

async function readStream(child: AntigravityChildProcess, emit: WorkerEventEmit, state: StreamState): Promise<void> {
	for await (const bounded of readBoundedLines(child.stdout, {
		maxLineBytes: ANTIGRAVITY_MAX_STREAM_LINE_BYTES,
		maxTotalBytes: ANTIGRAVITY_MAX_STREAM_BYTES,
	})) {
		if (bounded.kind === "oversized") {
			protocolFailure(state, "oversized structured output line");
			continue;
		}
		const line = bounded.line;
		if (!line.trim()) continue;
		const event = parseAntigravityStreamLine(line);
		if (!event) {
			protocolFailure(state, "unreadable structured output line");
			continue;
		}
		if (state.terminalSeen) {
			protocolFailure(state, "event after terminal result");
			continue;
		}
		switch (event.event) {
			case "init":
				if (state.initSeen) {
					protocolFailure(state, "duplicate init event");
					break;
				}
				state.initSeen = true;
				state.conversationId = boundedConversationId(event.conversationId);
				if (event.model?.trim()) state.model = event.model.trim();
				break;
			case "text":
				if (!state.initSeen) {
					protocolFailure(state, "text event before init");
					break;
				}
				state.conversationId = boundedConversationId(event.conversationId) ?? state.conversationId;
				emitTextDelta(emit, state, event.delta);
				break;
			case "result":
				if (!state.initSeen) {
					protocolFailure(state, "terminal result before init");
					break;
				}
				state.terminalSeen = true;
				state.result = event.result;
				state.conversationId = boundedConversationId(event.result.conversation_id) ?? state.conversationId;
				break;
			case "other":
				if (!state.initSeen) protocolFailure(state, "event before init");
				break;
		}
	}
}

function resultDiagnostic(input: {
	result: AntigravityResult | null;
	exitCode: number;
	spawnError: string;
	stderr: string;
	protocolDiagnostics: ReadonlyArray<string>;
	streamError: string;
	aborted: boolean;
}): string {
	if (input.aborted) return "Antigravity run was cancelled";
	if (input.spawnError) return input.spawnError;
	if (input.streamError) return input.streamError;
	if (input.protocolDiagnostics.length > 0) {
		return `Antigravity structured output violated the protocol: ${input.protocolDiagnostics.join("; ")}`;
	}
	if (input.result === null) {
		return "Antigravity CLI ended without a terminal stream result. Update `agy` and verify stream-json support.";
	}
	if (input.result.status !== "SUCCESS") {
		const providerError = boundedProviderField(input.result.error, "error").trim();
		return providerError || `Antigravity returned terminal status ${String(input.result.status ?? "missing")}`;
	}
	if (input.exitCode !== 0) return `Antigravity returned SUCCESS but exited with status ${input.exitCode}`;
	if (typeof input.result.response !== "string") return "Antigravity SUCCESS result omitted its required response";
	// Successful structured output is authoritative. Some CLI builds write
	// benign notices to stderr; retaining those as run failures would turn a
	// valid SUCCESS terminal record into a protocol contradiction.
	return "";
}

function buildAssistantMessage(input: {
	model: string;
	text: string;
	result: AntigravityResult | null;
	conversationId: string | null;
	exitCode: number;
	aborted: boolean;
	diagnostic: string;
}): AgentMessage & { role: "assistant" } {
	const succeeded =
		!input.aborted &&
		input.exitCode === 0 &&
		input.result?.status === "SUCCESS" &&
		typeof input.result.response === "string" &&
		input.diagnostic.length === 0;
	const message: AgentMessage & { role: "assistant" } = {
		role: "assistant",
		content: [{ type: "text", text: input.text }],
		api: "external-agent-subprocess",
		provider: "antigravity",
		model: input.model,
		usage: normalizeUsage(input.result?.usage),
		stopReason: input.aborted ? "aborted" : succeeded ? "stop" : "error",
		timestamp: Date.now(),
	} as AgentMessage & { role: "assistant" };
	// Opaque provider observation only. This runtime never accepts it as a
	// resumable Clio session id.
	if (input.conversationId) message.responseId = input.conversationId;
	if (input.diagnostic) message.errorMessage = boundedExternalDiagnostic(input.diagnostic);
	return message;
}

function defaultSpawn(
	file: string,
	args: ReadonlyArray<string>,
	options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["pipe", "pipe", "pipe"] },
): AntigravityChildProcess {
	return spawn(file, [...args], options);
}

export function startAntigravityWorkerRun(
	input: WorkerRunInput,
	emit: WorkerEventEmit,
	dependencies: AntigravityRuntimeDependencies = {},
): WorkerRunHandle {
	const sourceEnv = dependencies.environment ?? process.env;
	const args = buildAgyArgs(input, sourceEnv);
	const stdinLine = buildAgyStdinLine(input);
	const workspaceRoot = dependencies.workspaceRoot ?? process.cwd();
	const cwd = resolveSafeCwd(input.cwd, workspaceRoot);
	const child = (dependencies.spawnProcess ?? defaultSpawn)(dependencies.binary ?? ANTIGRAVITY_BINARY, args, {
		cwd,
		env: buildSafeToolEnv({}, sourceEnv),
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	const streamState: StreamState = {
		started: false,
		text: "",
		model: input.wireModelId,
		result: null,
		conversationId: null,
		initSeen: false,
		terminalSeen: false,
		protocolDiagnostics: [],
	};
	let aborted = false;
	let spawnError = "";
	let streamError = "";
	const terminator = createProcessTreeTerminator(child, dependencies.killGraceMs ?? 1500);
	const abort = (): void => {
		if (child.exitCode !== null) return;
		aborted = true;
		terminator.terminate();
	};
	const onAbort = (): void => abort();
	if (input.signal?.aborted) abort();
	else input.signal?.addEventListener("abort", onAbort, { once: true });
	child.once("error", (cause) => {
		spawnError =
			(cause as NodeJS.ErrnoException).code === "ENOENT"
				? "Antigravity CLI (`agy`) is not installed or not on PATH."
				: boundedExternalDiagnostic(cause.message);
	});
	child.stdin.on("error", (cause) => {
		if (!aborted) spawnError ||= boundedExternalDiagnostic(`could not send work order to Antigravity: ${cause.message}`);
	});
	child.stdin.end(stdinLine);

	const promise = (async (): Promise<WorkerRunResult> => {
		emit({ type: "agent_start" } as AgentEvent);
		try {
			const stderrPromise = readStderr(child);
			const stdoutPromise = readStream(child, emit, streamState).catch((cause) => {
				streamError = boundedExternalDiagnostic(cause instanceof Error ? cause.message : String(cause));
				terminator.terminate();
			});
			const exitCode = await waitForClose(child);
			await stdoutPromise;
			const stderr = await stderrPromise.catch((cause) =>
				boundedExternalDiagnostic(cause instanceof Error ? cause.message : String(cause)),
			);
			let terminalResponse = "";
			try {
				terminalResponse = boundedProviderField(streamState.result?.response, "response");
			} catch (cause) {
				streamError ||= boundedExternalDiagnostic(cause instanceof Error ? cause.message : String(cause));
			}
			let diagnostic = "";
			try {
				diagnostic = resultDiagnostic({
					result: streamState.result,
					exitCode,
					spawnError,
					stderr,
					protocolDiagnostics: streamState.protocolDiagnostics,
					streamError,
					aborted,
				});
			} catch (cause) {
				diagnostic = boundedExternalDiagnostic(cause instanceof Error ? cause.message : String(cause));
			}
			const finalText = terminalResponse || streamState.text;
			const finalMessage = buildAssistantMessage({
				model: streamState.model,
				text: finalText,
				result: streamState.result,
				conversationId: streamState.conversationId,
				exitCode,
				aborted,
				diagnostic,
			});
			if (!streamState.started) emit({ type: "message_start", message: finalMessage } as AgentEvent);
			emit({ type: "message_end", message: finalMessage } as AgentEvent);
			const messages: AgentMessage[] = [finalMessage];
			emit({ type: "agent_end", messages } as AgentEvent);
			if (finalMessage.stopReason === "error" && diagnostic && !aborted) {
				process.stderr.write(`[worker:antigravity-code] ${boundedExternalDiagnostic(diagnostic)}\n`);
			}
			return { messages, exitCode: finalMessage.stopReason === "stop" ? 0 : 1 };
		} finally {
			terminator.cleanup();
			input.signal?.removeEventListener("abort", onAbort);
		}
	})();

	return { promise, abort };
}
