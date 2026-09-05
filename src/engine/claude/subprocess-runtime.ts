import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { buildSafeToolEnv, resolveSafeCwd } from "../../core/safe-exec.js";
import type { AutonomyLevel } from "../../domains/safety/autonomy.js";
import { assertToolProfileEnforceable } from "../../tools/profiles.js";
import { createProcessTreeTerminator, readBoundedLines, readStderr, waitForClose } from "../external-subprocess.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";
import { isClaudeCodeSessionId } from "./session-id.js";

const READ_ONLY_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"] as const;

/** Official CLI binary, resolved from the operator's PATH. */
const CLAUDE_BINARY = "claude";
export const CLAUDE_MAX_STREAM_LINE_BYTES = 1024 * 1024;
export const CLAUDE_MAX_STREAM_BYTES = 8 * 1024 * 1024;

type ClaudeChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface ClaudeRuntimeDependencies {
	binary?: string;
	workspaceRoot?: string;
	environment?: NodeJS.ProcessEnv;
	killGraceMs?: number;
}

export interface ClaudeSubprocessPermissionConfig {
	permissionMode: "plan" | "dontAsk" | "acceptEdits" | "default" | "bypassPermissions";
	extraArgs: string[];
	dangerousBypass: boolean;
}

export function claudeSubprocessPermissionConfigForAutonomy(
	level: AutonomyLevel | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ClaudeSubprocessPermissionConfig {
	if (level === "full-auto" && env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS === "1") {
		return {
			permissionMode: "bypassPermissions",
			extraArgs: ["--allow-dangerously-skip-permissions"],
			dangerousBypass: true,
		};
	}
	if (level === "read-only") {
		return {
			permissionMode: "plan",
			extraArgs: ["--tools", READ_ONLY_CLAUDE_TOOLS.join(",")],
			dangerousBypass: false,
		};
	}
	if (level === "suggest") {
		throw new Error(
			"claude-code runtime cannot enforce autonomy 'suggest': it cannot park tool calls for approval. Dispatch to a native or claude-sdk worker, or use read-only or auto-edit.",
		);
	}
	if (level === "auto-edit") {
		return { permissionMode: "acceptEdits", extraArgs: [], dangerousBypass: false };
	}
	return { permissionMode: "default", extraArgs: [], dangerousBypass: false };
}

export function buildClaudeCodePrompt(input: WorkerRunInput): string {
	const parts = (input.dynamicPromptMessages ?? []).map((message) => message.body.trim()).filter(Boolean);
	parts.push(input.task);
	return parts.join("\n\n");
}

/**
 * `claude -p` reads the user prompt from stdin when no positional prompt is
 * given, so the prompt never appears in argv. The system prompt stays on
 * `--append-system-prompt`: stdin carries only the user turn.
 */
export function buildClaudeCodeArgs(input: WorkerRunInput, gateEnv: NodeJS.ProcessEnv = process.env): string[] {
	assertToolProfileEnforceable(input.toolProfile, "claude-code");
	const permission = claudeSubprocessPermissionConfigForAutonomy(input.autonomy, gateEnv);
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--no-session-persistence",
		"--permission-mode",
		permission.permissionMode,
		...permission.extraArgs,
	];
	if (input.wireModelId.trim().length > 0) args.push("--model", input.wireModelId);
	const systemPrompt = input.systemPrompt.trim();
	if (systemPrompt.length > 0) args.push("--append-system-prompt", systemPrompt);
	if (isClaudeCodeSessionId(input.sessionId)) args.push("--session-id", input.sessionId.trim());
	return args;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeUsage(raw: unknown, totalCostUsd = 0): Usage {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const input =
		finite(record.input_tokens) +
		finite(record.inputTokens) +
		finite(record.input) +
		finite(record.prompt_tokens) +
		finite(record.promptTokens);
	const output =
		finite(record.output_tokens) +
		finite(record.outputTokens) +
		finite(record.output) +
		finite(record.completion_tokens) +
		finite(record.completionTokens);
	const cacheRead =
		finite(record.cache_read_input_tokens) +
		finite(record.cacheReadInputTokens) +
		finite(record.cacheRead) +
		finite(record.cacheReadTokens);
	const cacheWrite =
		finite(record.cache_creation_input_tokens) +
		finite(record.cacheCreationInputTokens) +
		finite(record.cacheWrite) +
		finite(record.cacheWriteTokens);
	const totalTokens = input + output + cacheRead + cacheWrite;
	const total = finite(totalCostUsd) + finite(record.costUSD) + finite(record.cost_usd);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") out += record.text;
	}
	return out;
}

function extractDelta(record: Record<string, unknown>): string {
	const delta = nestedRecord(record, "delta");
	if (delta && typeof delta.text === "string") return delta.text;
	if (delta && typeof delta.thinking === "string") return "";
	const contentBlock = nestedRecord(record, "content_block");
	if (contentBlock && contentBlock.type === "text" && typeof contentBlock.text === "string") return contentBlock.text;
	if (typeof record.delta === "string") return record.delta;
	return "";
}

function assistantTextFromEvent(record: Record<string, unknown>): string {
	const message = nestedRecord(record, "message");
	if (message) return extractContentText(message.content);
	return extractContentText(record.content);
}

function resultText(record: Record<string, unknown> | null): string {
	if (!record) return "";
	return typeof record.result === "string" ? record.result : "";
}

function resultError(record: Record<string, unknown> | null, stderr: string): string {
	if (record) {
		if (typeof record.error === "string") return record.error;
		if (Array.isArray(record.errors)) return record.errors.map(String).join("; ");
		if (record.subtype !== undefined && record.subtype !== "success") return String(record.subtype);
	}
	return stderr.trim();
}

function buildAssistantMessage(input: {
	model: string;
	text: string;
	result: Record<string, unknown> | null;
	exitCode: number;
	aborted: boolean;
	stderr: string;
	transportError?: string;
}): AgentMessage & { role: "assistant" } {
	const transportError = input.transportError ?? "";
	const failed = input.exitCode !== 0 || transportError.length > 0;
	const errorMessage = !failed ? "" : transportError || resultError(input.result, input.stderr);
	const message: AgentMessage & { role: "assistant" } = {
		role: "assistant",
		content: [{ type: "text", text: input.text }],
		api: "claude-code-subprocess",
		provider: "anthropic",
		model: input.model,
		usage: normalizeUsage(input.result?.usage, finite(input.result?.total_cost_usd)),
		stopReason: input.aborted ? "aborted" : failed ? "error" : "stop",
		timestamp: Date.now(),
	} as AgentMessage & { role: "assistant" };
	if (typeof input.result?.request_id === "string") message.responseId = input.result.request_id;
	if (typeof input.result?.model === "string") message.responseModel = input.result.model;
	if (errorMessage.length > 0) message.errorMessage = boundedExternalDiagnostic(errorMessage);
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
		result: null,
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

async function readJsonLines(
	child: ClaudeChildProcess,
	emit: WorkerEventEmit,
	state: { started: boolean; text: string; model: string; result: Record<string, unknown> | null },
): Promise<void> {
	for await (const bounded of readBoundedLines(child.stdout, {
		maxLineBytes: CLAUDE_MAX_STREAM_LINE_BYTES,
		maxTotalBytes: CLAUDE_MAX_STREAM_BYTES,
	})) {
		if (bounded.kind === "oversized") {
			throw new Error(`claude stream-json line exceeded ${CLAUDE_MAX_STREAM_LINE_BYTES} bytes`);
		}
		const trimmed = bounded.line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		if (record.type === "system" && typeof record.model === "string") state.model = record.model;
		if (record.type === "result") {
			state.result = record;
			continue;
		}
		if (record.type === "assistant") {
			const text = assistantTextFromEvent(record);
			if (text.length > 0 && text.length >= state.text.length) state.text = text;
			continue;
		}
		emitTextDelta(emit, state, extractDelta(record));
	}
}

export function startClaudeCodeWorkerRun(
	input: WorkerRunInput,
	emit: WorkerEventEmit,
	dependencies: ClaudeRuntimeDependencies = {},
): WorkerRunHandle {
	const sourceEnv = dependencies.environment ?? process.env;
	const args = buildClaudeCodeArgs(input, sourceEnv);
	const prompt = buildClaudeCodePrompt(input);
	const workspaceRoot = dependencies.workspaceRoot ?? process.cwd();
	const cwd = resolveSafeCwd(input.cwd, workspaceRoot);
	const child: ClaudeChildProcess = spawn(dependencies.binary ?? CLAUDE_BINARY, args, {
		cwd,
		env: buildSafeToolEnv({}, sourceEnv),
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	const streamState = {
		started: false,
		text: "",
		model: input.wireModelId,
		result: null as Record<string, unknown> | null,
	};
	let aborted = false;
	let transportError = "";
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
		transportError ||=
			(cause as NodeJS.ErrnoException).code === "ENOENT"
				? "Claude Code CLI (`claude`) is not installed or not on PATH."
				: cause.message;
	});
	child.stdin.on("error", (cause) => {
		if (!aborted) transportError ||= `could not send prompt to Claude Code CLI: ${cause.message}`;
	});
	child.stdin.end(prompt);

	const promise = (async (): Promise<WorkerRunResult> => {
		emit({ type: "agent_start" } as AgentEvent);
		try {
			const stderrPromise = readStderr(child);
			const stdoutPromise = readJsonLines(child, emit, streamState).catch((cause) => {
				transportError ||= cause instanceof Error ? cause.message : String(cause);
				terminator.terminate();
			});
			const exitCode = await waitForClose(child);
			await stdoutPromise;
			const stderr = await stderrPromise.catch(() => "");
			const finalText =
				streamState.text ||
				resultText(streamState.result) ||
				(exitCode === 0 ? "" : resultError(streamState.result, stderr));
			const finalMessage = buildAssistantMessage({
				model: streamState.model,
				text: finalText,
				result: streamState.result,
				exitCode,
				aborted,
				stderr,
				transportError,
			});
			if (!streamState.started) emit({ type: "message_start", message: finalMessage } as AgentEvent);
			emit({ type: "message_end", message: finalMessage } as AgentEvent);
			const messages: AgentMessage[] = [finalMessage];
			emit({ type: "agent_end", messages } as AgentEvent);
			if (finalMessage.stopReason === "error" && finalMessage.errorMessage && !aborted) {
				process.stderr.write(`[worker:claude-code] ${finalMessage.errorMessage}\n`);
			}
			return { messages, exitCode: finalMessage.stopReason === "stop" ? 0 : 1 };
		} finally {
			terminator.cleanup();
			input.signal?.removeEventListener("abort", onAbort);
		}
	})();

	return { promise, abort };
}
