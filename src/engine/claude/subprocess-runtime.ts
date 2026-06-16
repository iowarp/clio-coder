import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { AutonomyLevel } from "../../domains/safety/autonomy.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";
import { isClaudeCodeSessionId } from "./session-id.js";

const READ_ONLY_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"] as const;

type ClaudeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ClaudeSubprocessPermissionConfig {
	permissionMode: "plan" | "dontAsk" | "acceptEdits" | "default" | "bypassPermissions";
	extraArgs: string[];
	dangerousBypass: boolean;
}

export function claudeSubprocessPermissionConfigForAutonomy(
	level: AutonomyLevel | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ClaudeSubprocessPermissionConfig {
	if (level === "full-auto" && env.CLIO_ALLOW_EXTERNAL_FULL_ACCESS === "1") {
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
		return {
			permissionMode: "dontAsk",
			extraArgs: ["--tools", READ_ONLY_CLAUDE_TOOLS.join(",")],
			dangerousBypass: false,
		};
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

export function buildClaudeCodeArgs(input: WorkerRunInput): string[] {
	const permission = claudeSubprocessPermissionConfigForAutonomy(input.autonomy);
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
	args.push(buildClaudeCodePrompt(input));
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
}): AgentMessage & { role: "assistant" } {
	const errorMessage = input.exitCode === 0 ? "" : resultError(input.result, input.stderr);
	const message: AgentMessage & { role: "assistant" } = {
		role: "assistant",
		content: [{ type: "text", text: input.text }],
		api: "claude-code-subprocess",
		provider: "anthropic",
		model: input.model,
		usage: normalizeUsage(input.result?.usage, finite(input.result?.total_cost_usd)),
		stopReason: input.aborted ? "aborted" : input.exitCode === 0 ? "stop" : "error",
		timestamp: Date.now(),
	} as AgentMessage & { role: "assistant" };
	if (typeof input.result?.request_id === "string") message.responseId = input.result.request_id;
	if (typeof input.result?.model === "string") message.responseModel = input.result.model;
	if (errorMessage.length > 0) message.errorMessage = errorMessage;
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
	const rl = createInterface({ input: child.stdout });
	for await (const line of rl) {
		const trimmed = line.trim();
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

async function readStderr(child: ClaudeChildProcess): Promise<string> {
	let stderr = "";
	for await (const chunk of child.stderr) {
		stderr += String(chunk);
		if (stderr.length > 8192) stderr = stderr.slice(-8192);
	}
	return stderr;
}

function waitForClose(child: ClaudeChildProcess): Promise<number> {
	return new Promise((resolve) => {
		child.once("error", () => resolve(1));
		child.once("close", (code) => resolve(code ?? 1));
	});
}

export function startClaudeCodeWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const args = buildClaudeCodeArgs(input);
	const child = spawn("claude", args, {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const streamState = {
		started: false,
		text: "",
		model: input.wireModelId,
		result: null as Record<string, unknown> | null,
	};
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
		const stdoutPromise = readJsonLines(child, emit, streamState);
		const exitCode = await waitForClose(child);
		await stdoutPromise.catch(() => {});
		const stderr = await stderrPromise.catch(() => "");
		if (killTimer) clearTimeout(killTimer);
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
		});
		if (!streamState.started) emit({ type: "message_start", message: finalMessage } as AgentEvent);
		emit({ type: "message_end", message: finalMessage } as AgentEvent);
		const messages: AgentMessage[] = [finalMessage];
		emit({ type: "agent_end", messages } as AgentEvent);
		if (exitCode !== 0 && stderr.trim().length > 0 && !aborted) {
			process.stderr.write(`[worker:claude-code] ${stderr.trim()}\n`);
		}
		return { messages, exitCode: exitCode === 0 ? 0 : 1 };
	})();

	return {
		promise,
		abort,
		steer(_text: string) {
			// `claude -p` is started as a single prompt subprocess. Steering is
			// supported by the SDK runtime; this path stays single-turn.
		},
	};
}
