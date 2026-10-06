import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { buildSafeToolEnv, resolveSafeCwd } from "../../core/safe-exec.js";
import {
	createProcessTreeTerminator,
	EXTERNAL_PROCESS_KILL_GRACE_MS,
	readBoundedLines,
	readStderr,
} from "../external-subprocess.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";

type CliChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface JsonlCliState {
	text: string;
	model: string;
	responseId: string | null;
	sessionId: string | null;
	usage: Usage | null;
	usageReported: boolean;
	costReported: boolean;
	terminal: boolean;
	error: string;
}

export interface JsonlCliConnector {
	runtimeId: string;
	label: string;
	binary: string;
	/** CLI-owned configuration directory variable, passed explicitly when set. */
	configDirEnv?: "OPENCODE_CONFIG_DIR" | "PI_CODING_AGENT_DIR";
	/** Explicit environment references in the peer's own local configuration. */
	extraEnv?(sourceEnv: NodeJS.ProcessEnv): Record<string, string>;
	args(input: WorkerRunInput): string[];
	prompt(input: WorkerRunInput): string;
	/** Parse only the peer's own JSONL envelope; lifecycle and bounded IO are shared. */
	onEvent(event: Record<string, unknown>, state: JsonlCliState, append: (text: string) => void): void;
	/** Some peers emit only a process exit after their final text event. */
	requireTerminalEvent: boolean;
}

export interface JsonlCliDependencies {
	binary?: string;
	workspaceRoot?: string;
	environment?: NodeJS.ProcessEnv;
	killGraceMs?: number;
}

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function finiteUsage(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(value, Number.MAX_SAFE_INTEGER)
		: 0;
}

export function emptyCliUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function cliEventRecord(value: unknown): Record<string, unknown> | null {
	return record(value);
}

export function startJsonlCliRun(
	connector: JsonlCliConnector,
	input: WorkerRunInput,
	emit: WorkerEventEmit,
	dependencies: JsonlCliDependencies = {},
): WorkerRunHandle {
	input.signal?.throwIfAborted();
	const sourceEnv = dependencies.environment ?? process.env;
	const cwd = resolveSafeCwd(input.cwd, dependencies.workspaceRoot ?? process.cwd());
	const configDir = connector.configDirEnv ? sourceEnv[connector.configDirEnv] : undefined;
	const child: CliChild = spawn(dependencies.binary ?? connector.binary, connector.args(input), {
		cwd,
		env: buildSafeToolEnv(
			{
				...(configDir && connector.configDirEnv ? { [connector.configDirEnv]: configDir } : {}),
				...(connector.extraEnv?.(sourceEnv) ?? {}),
			},
			sourceEnv,
		),
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	const state: JsonlCliState = {
		text: "",
		model: input.wireModelId,
		responseId: null,
		sessionId: null,
		usage: null,
		usageReported: false,
		costReported: false,
		terminal: false,
		error: "",
	};
	let responseBytes = 0;
	let messageStarted = false;
	let aborted = false;
	let settled = false;
	let transportError = "";
	const terminator = createProcessTreeTerminator(child, dependencies.killGraceMs ?? EXTERNAL_PROCESS_KILL_GRACE_MS);
	const abort = (): void => {
		if (settled) return;
		aborted = true;
		terminator.terminate();
	};
	const onAbort = (): void => abort();
	if (input.signal?.aborted) abort();
	else input.signal?.addEventListener("abort", onAbort, { once: true });
	const onChildError = (cause: Error): void => {
		transportError ||=
			(cause as NodeJS.ErrnoException).code === "ENOENT"
				? `${connector.label} (${connector.binary}) is not installed or not on PATH.`
				: boundedExternalDiagnostic(cause.message);
	};
	const onStdinError = (cause: Error): void => {
		if (!aborted)
			transportError ||= boundedExternalDiagnostic(`could not send task to ${connector.label}: ${cause.message}`);
	};
	child.once("error", onChildError);
	child.stdin.on("error", onStdinError);
	child.stdin.end(connector.prompt(input));

	const message = (exitCode: number, diagnostic: string): AgentMessage & { role: "assistant" } => {
		const succeeded = !aborted && exitCode === 0 && !diagnostic;
		const usage = (state.usage ?? emptyCliUsage()) as Usage & { clioExternal?: Record<string, unknown> };
		usage.clioExternal = {
			tokenUsage: state.usageReported ? "provider-reported" : "missing",
			cost: state.costReported ? "provider-reported" : "missing",
			sessionId: state.sessionId,
		};
		const result: AgentMessage & { role: "assistant" } = {
			role: "assistant",
			content: [{ type: "text", text: state.text }],
			api: "external-agent-subprocess",
			provider: connector.runtimeId,
			model: state.model,
			usage,
			stopReason: aborted ? "aborted" : succeeded ? "stop" : "error",
			timestamp: Date.now(),
		} as AgentMessage & { role: "assistant" };
		if (state.responseId) result.responseId = state.responseId;
		if (diagnostic) result.errorMessage = boundedExternalDiagnostic(diagnostic);
		return result;
	};
	const append = (delta: string): void => {
		if (!delta) return;
		const deltaBytes = Buffer.byteLength(delta, "utf8");
		const previousTail = state.text.charCodeAt(state.text.length - 1);
		const nextHead = delta.charCodeAt(0);
		// A split surrogate replaces two three-byte replacements with one four-byte code point.
		const joinsSurrogates = previousTail >= 0xd800 && previousTail <= 0xdbff && nextHead >= 0xdc00 && nextHead <= 0xdfff;
		const nextResponseBytes = responseBytes + deltaBytes - (joinsSurrogates ? 2 : 0);
		if (nextResponseBytes > MAX_RESPONSE_BYTES) {
			throw new Error(`${connector.label} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
		}
		if (!messageStarted) {
			messageStarted = true;
			emit({ type: "message_start", message: message(0, "") } as AgentEvent);
		}
		responseBytes = nextResponseBytes;
		state.text += delta;
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } } as AgentEvent);
	};
	const promise = (async (): Promise<WorkerRunResult> => {
		emit({ type: "agent_start" } as AgentEvent);
		try {
			const stderrPromise = readStderr(child).catch(() => "");
			const stdoutPromise = (async () => {
				for await (const bounded of readBoundedLines(child.stdout, {
					maxLineBytes: MAX_LINE_BYTES,
					maxTotalBytes: MAX_STREAM_BYTES,
				})) {
					if (bounded.kind === "oversized")
						throw new Error(`${connector.label} JSONL line exceeded ${MAX_LINE_BYTES} bytes`);
					if (!bounded.line.trim()) continue;
					let decoded: unknown;
					try {
						decoded = JSON.parse(bounded.line);
					} catch {
						throw new Error(`${connector.label} returned an invalid JSONL event`);
					}
					const event = record(decoded);
					if (!event || typeof event.type !== "string")
						throw new Error(`${connector.label} returned an invalid JSONL event`);
					connector.onEvent(event, state, append);
				}
			})().catch((cause) => {
				transportError ||= boundedExternalDiagnostic(cause instanceof Error ? cause.message : String(cause));
				terminator.terminate();
			});
			const outcome = await terminator.completed;
			const exitCode = outcome.exitCode;
			await stdoutPromise;
			const stderr = await stderrPromise;
			const diagnostic = aborted
				? `${connector.label} run was cancelled`
				: transportError ||
					(outcome.incomplete ? `${connector.label} process group cleanup incomplete` : "") ||
					(outcome.pipeDrainIncomplete ? `${connector.label} output pipe draining incomplete` : "") ||
					state.error ||
					(connector.requireTerminalEvent && !state.terminal
						? `${connector.label} ended without a terminal JSONL event`
						: "") ||
					(!state.text.trim() ? `${connector.label} ended without an assistant response` : "") ||
					(exitCode !== 0 ? stderr || `${connector.label} exited with status ${exitCode}` : "");
			const finalMessage = message(exitCode, diagnostic);
			if (!messageStarted) emit({ type: "message_start", message: finalMessage } as AgentEvent);
			emit({ type: "message_end", message: finalMessage } as AgentEvent);
			const messages: AgentMessage[] = [finalMessage];
			emit({ type: "agent_end", messages } as AgentEvent);
			if (finalMessage.stopReason === "error" && diagnostic && !aborted) {
				process.stderr.write(`[worker:${connector.runtimeId}] ${boundedExternalDiagnostic(diagnostic)}\n`);
			}
			return { messages, exitCode: finalMessage.stopReason === "stop" ? 0 : 1 };
		} finally {
			settled = true;
			terminator.cleanup();
			input.signal?.removeEventListener("abort", onAbort);
			child.off("error", onChildError);
			child.stdin.off("error", onStdinError);
		}
	})();
	return { promise, abort };
}
