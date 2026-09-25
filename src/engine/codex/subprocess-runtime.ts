import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { buildSafeToolEnv, resolveSafeCwd } from "../../core/safe-exec.js";
import { codexSubprocessPermissionConfigForAutonomy } from "../../domains/providers/runtimes/external-cli-policy.js";
import { assertToolProfileEnforceable } from "../../tools/profiles.js";
import { createProcessTreeTerminator, readBoundedLines, readStderr, waitForClose } from "../external-subprocess.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";

const CODEX_BINARY = "codex";
export const CODEX_CLI_DEFAULT_MODEL = "codex-cli-default";
export const CODEX_MAX_STREAM_LINE_BYTES = 1024 * 1024;
export const CODEX_MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const CODEX_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type CodexChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface CodexRuntimeDependencies {
	binary?: string;
	workspaceRoot?: string;
	environment?: NodeJS.ProcessEnv;
	killGraceMs?: number;
}

export type { CodexSubprocessPermissionConfig } from "../../domains/providers/runtimes/external-cli-policy.js";
export { codexSubprocessPermissionConfigForAutonomy } from "../../domains/providers/runtimes/external-cli-policy.js";

export function buildCodexExecPrompt(input: WorkerRunInput): string {
	return [
		input.systemPrompt.trim(),
		...(input.dynamicPromptMessages ?? []).map((message) => message.body.trim()),
		input.task.trim(),
	]
		.filter(Boolean)
		.join("\n\n");
}

/** `codex exec -` reads the work order from stdin; prompt text never enters argv. */
export function buildCodexExecArgs(input: WorkerRunInput, gateEnv: NodeJS.ProcessEnv = process.env): string[] {
	assertToolProfileEnforceable(input.toolProfile, "codex-cli");
	const permission = codexSubprocessPermissionConfigForAutonomy(input.autonomy, gateEnv, input.readOnly === true);
	const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check"];
	if (permission.dangerousBypass) args.push("--dangerously-bypass-approvals-and-sandbox");
	else args.push("--sandbox", permission.sandbox);
	if (input.wireModelId.trim() && input.wireModelId !== CODEX_CLI_DEFAULT_MODEL) {
		args.push("--model", input.wireModelId.trim());
	}
	args.push("-");
	return args;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(value, Number.MAX_SAFE_INTEGER)
		: 0;
}

function normalizeUsage(raw: unknown): Usage {
	const usage = record(raw);
	const totalInput = finite(usage?.input_tokens);
	const cacheRead = Math.min(totalInput, finite(usage?.cached_input_tokens));
	const cacheWrite = Math.min(totalInput - cacheRead, finite(usage?.cache_write_input_tokens));
	const output = finite(usage?.output_tokens);
	const result: Usage & { reasoningTokens?: number } = {
		input: totalInput - cacheRead - cacheWrite,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: totalInput + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const reasoning = finite(usage?.reasoning_output_tokens);
	if (reasoning > 0) result.reasoningTokens = reasoning;
	return result;
}

interface StreamState {
	started: boolean;
	text: string;
	threadId: string | null;
	threadStarted: boolean;
	turnStarted: boolean;
	terminal: "completed" | "failed" | null;
	usage: unknown;
	error: string;
}

function appendText(emit: WorkerEventEmit, state: StreamState, delta: string): void {
	if (!delta) return;
	if (Buffer.byteLength(state.text, "utf8") + Buffer.byteLength(delta, "utf8") > CODEX_MAX_RESPONSE_BYTES) {
		throw new Error(`Codex response exceeded ${CODEX_MAX_RESPONSE_BYTES} bytes`);
	}
	if (!state.started) {
		state.started = true;
		emit({ type: "message_start", message: assistantMessage(state, 0, false, "") } as AgentEvent);
	}
	state.text += delta;
	emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	} as AgentEvent);
}

async function readCodexEvents(child: CodexChildProcess, emit: WorkerEventEmit, state: StreamState): Promise<void> {
	for await (const bounded of readBoundedLines(child.stdout, {
		maxLineBytes: CODEX_MAX_STREAM_LINE_BYTES,
		maxTotalBytes: CODEX_MAX_STREAM_BYTES,
	})) {
		if (bounded.kind === "oversized") throw new Error(`Codex JSONL line exceeded ${CODEX_MAX_STREAM_LINE_BYTES} bytes`);
		if (!bounded.line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(bounded.line);
		} catch {
			throw new Error("Codex returned an invalid JSONL event");
		}
		const event = record(parsed);
		if (!event || typeof event.type !== "string") throw new Error("Codex returned an invalid JSONL event");
		if (state.terminal) throw new Error("Codex emitted an event after its terminal turn");
		switch (event.type) {
			case "thread.started":
				if (state.threadStarted || typeof event.thread_id !== "string" || !event.thread_id) {
					throw new Error("Codex returned an invalid or duplicate thread.start event");
				}
				state.threadStarted = true;
				state.threadId = event.thread_id;
				break;
			case "turn.started":
				if (!state.threadStarted || state.turnStarted) throw new Error("Codex returned an out-of-order turn.start event");
				state.turnStarted = true;
				break;
			case "item.completed": {
				if (!state.turnStarted) throw new Error("Codex returned an item before turn.start");
				const item = record(event.item);
				if (item?.type === "agent_message" && typeof item.text === "string") {
					appendText(emit, state, `${state.text ? "\n" : ""}${item.text}`);
				}
				break;
			}
			case "turn.completed":
			case "turn.failed":
				if (!state.turnStarted) throw new Error("Codex returned a terminal turn before turn.start");
				state.terminal = event.type === "turn.completed" ? "completed" : "failed";
				state.usage = event.usage;
				if (event.type === "turn.failed") {
					state.error = boundedExternalDiagnostic(
						String(record(event.error)?.message ?? event.message ?? "Codex turn failed"),
					);
				}
				break;
			case "error":
				state.error = boundedExternalDiagnostic(String(event.message ?? "Codex reported an error"));
				break;
		}
	}
}

function assistantMessage(
	state: StreamState,
	exitCode: number,
	aborted: boolean,
	diagnostic: string,
): AgentMessage & { role: "assistant" } {
	const succeeded = !aborted && exitCode === 0 && state.terminal === "completed" && !diagnostic;
	const usage = normalizeUsage(state.usage) as Usage & { clioExternal?: Record<string, unknown> };
	const rawUsage = record(state.usage);
	usage.clioExternal = {
		tokenUsage: [rawUsage?.input_tokens, rawUsage?.output_tokens].some(
			(value) => typeof value === "number" && Number.isFinite(value),
		)
			? "provider-reported"
			: "missing",
		cost: "missing",
		sessionId: state.threadId,
	};
	const message: AgentMessage & { role: "assistant" } = {
		role: "assistant",
		content: [{ type: "text", text: state.text }],
		api: "external-agent-subprocess",
		provider: "openai-codex",
		model: CODEX_CLI_DEFAULT_MODEL,
		usage,
		stopReason: aborted ? "aborted" : succeeded ? "stop" : "error",
		timestamp: Date.now(),
	} as AgentMessage & { role: "assistant" };
	if (state.threadId) message.responseId = state.threadId;
	if (diagnostic) message.errorMessage = boundedExternalDiagnostic(diagnostic);
	return message;
}

export function startCodexCliWorkerRun(
	input: WorkerRunInput,
	emit: WorkerEventEmit,
	dependencies: CodexRuntimeDependencies = {},
): WorkerRunHandle {
	const sourceEnv = dependencies.environment ?? process.env;
	const args = buildCodexExecArgs(input, sourceEnv);
	const prompt = buildCodexExecPrompt(input);
	const cwd = resolveSafeCwd(input.cwd, dependencies.workspaceRoot ?? process.cwd());
	const child: CodexChildProcess = spawn(dependencies.binary ?? CODEX_BINARY, args, {
		cwd,
		env: buildSafeToolEnv(sourceEnv.CODEX_HOME ? { CODEX_HOME: sourceEnv.CODEX_HOME } : {}, sourceEnv),
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	const state: StreamState = {
		started: false,
		text: "",
		threadId: null,
		threadStarted: false,
		turnStarted: false,
		terminal: null,
		usage: null,
		error: "",
	};
	let aborted = false;
	let settled = false;
	let transportError = "";
	const terminator = createProcessTreeTerminator(child, dependencies.killGraceMs ?? 1500);
	const abort = (): void => {
		if (settled) return;
		aborted = true;
		terminator.terminate();
	};
	const onAbort = (): void => abort();
	if (input.signal?.aborted) abort();
	else input.signal?.addEventListener("abort", onAbort, { once: true });
	child.once("error", (cause) => {
		transportError ||=
			(cause as NodeJS.ErrnoException).code === "ENOENT"
				? "Codex CLI (`codex`) is not installed or not on PATH."
				: boundedExternalDiagnostic(cause.message);
	});
	child.stdin.on("error", (cause) => {
		if (!aborted)
			transportError ||= boundedExternalDiagnostic(`could not send work order to Codex CLI: ${cause.message}`);
	});
	child.stdin.end(prompt);

	const promise = (async (): Promise<WorkerRunResult> => {
		emit({ type: "agent_start" } as AgentEvent);
		try {
			const stderrPromise = readStderr(child);
			const stdoutPromise = readCodexEvents(child, emit, state).catch((cause) => {
				transportError ||= boundedExternalDiagnostic(cause instanceof Error ? cause.message : String(cause));
				terminator.terminate();
			});
			const exitCode = await waitForClose(child);
			await stdoutPromise;
			const stderr = await stderrPromise.catch(() => "");
			const diagnostic = aborted
				? "Codex run was cancelled"
				: transportError ||
					state.error ||
					(state.terminal === "failed" ? "Codex turn failed" : "") ||
					(state.terminal === null ? "Codex CLI ended without a terminal JSONL turn" : "") ||
					(!state.text.trim() ? "Codex CLI ended without an assistant response" : "") ||
					(exitCode !== 0 ? stderr || `Codex CLI exited with status ${exitCode}` : "");
			const finalMessage = assistantMessage(state, exitCode, aborted, diagnostic);
			finalMessage.model = input.wireModelId;
			if (!state.started) emit({ type: "message_start", message: finalMessage } as AgentEvent);
			emit({ type: "message_end", message: finalMessage } as AgentEvent);
			const messages: AgentMessage[] = [finalMessage];
			emit({ type: "agent_end", messages } as AgentEvent);
			if (finalMessage.stopReason === "error" && diagnostic && !aborted) {
				process.stderr.write(`[worker:codex-cli] ${boundedExternalDiagnostic(diagnostic)}\n`);
			}
			return { messages, exitCode: finalMessage.stopReason === "stop" ? 0 : 1 };
		} finally {
			settled = true;
			terminator.cleanup();
			input.signal?.removeEventListener("abort", onAbort);
		}
	})();
	return { promise, abort };
}
