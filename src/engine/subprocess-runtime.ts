/**
 * CLI-agent subprocess worker. Spawns claude/codex/gemini with a single-shot
 * prompt and collects stdout into one synthesized AssistantMessage. v0.2
 * limitations, documented deliberately:
 *   - no streaming tool-call parsing (stream-json modes exist but are not parsed)
 *   - no image inputs (CLI agents accept them inconsistently)
 *   - single-turn only (workers are dispatched one task at a time)
 */

import { type ChildProcess, spawn } from "node:child_process";

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { EndpointDescriptor, RuntimeDescriptor } from "../domains/providers/index.js";
import type { AgentEvent, AgentMessage } from "./types.js";

export interface SubprocessWorkerInput {
	systemPrompt: string;
	task: string;
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	apiKey?: string;
	signal?: AbortSignal;
}

export interface SubprocessWorkerResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface SubprocessWorkerHandle {
	promise: Promise<SubprocessWorkerResult>;
	abort(): void;
}

interface InvocationPlan {
	binary: string;
	args: string[];
	stdin?: string;
	envKeyName?: string;
	provider: string;
	api: string;
}

function planInvocation(input: SubprocessWorkerInput): InvocationPlan {
	const { runtime, wireModelId, task, systemPrompt } = input;
	switch (runtime.id) {
		case "claude-code-cli": {
			const args = ["--print", "--model", wireModelId];
			if (systemPrompt.length > 0) {
				args.push("--append-system-prompt", systemPrompt);
			}
			args.push(task);
			return {
				binary: "claude",
				args,
				provider: "anthropic",
				api: "subprocess-claude-code",
				...(runtime.credentialsEnvVar ? { envKeyName: runtime.credentialsEnvVar } : {}),
			};
		}
		case "codex-cli": {
			const args = ["exec", "-m", wireModelId];
			const stdinChunks: string[] = [];
			if (systemPrompt.length > 0) stdinChunks.push(systemPrompt, "");
			stdinChunks.push(task);
			return {
				binary: "codex",
				args: [...args, "-"],
				stdin: stdinChunks.join("\n"),
				provider: "openai",
				api: "subprocess-codex",
				...(runtime.credentialsEnvVar ? { envKeyName: runtime.credentialsEnvVar } : {}),
			};
		}
		case "gemini-cli": {
			const args = ["-p", task, "-m", wireModelId];
			const plan: InvocationPlan = {
				binary: "gemini",
				args,
				provider: "google",
				api: "subprocess-gemini",
			};
			if (systemPrompt.length > 0) plan.stdin = systemPrompt;
			if (runtime.credentialsEnvVar) plan.envKeyName = runtime.credentialsEnvVar;
			return plan;
		}
		default:
			throw new Error(`subprocess-runtime: unknown runtime id '${runtime.id}'`);
	}
}

function buildAssistantMessage(
	plan: InvocationPlan,
	wireModelId: string,
	text: string,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content: text.length > 0 ? [{ type: "text", text }] : [],
		api: plan.api,
		provider: plan.provider,
		model: wireModelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

export function startSubprocessWorkerRun(
	input: SubprocessWorkerInput,
	emit: (event: AgentEvent) => void,
): SubprocessWorkerHandle {
	const plan = planInvocation(input);
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (plan.envKeyName && input.apiKey && input.apiKey.length > 0) {
		env[plan.envKeyName] = input.apiKey;
	}

	let child: ChildProcess;
	let aborted = false;
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];

	const promise = new Promise<SubprocessWorkerResult>((resolve) => {
		emit({ type: "agent_start" });

		if (input.signal?.aborted) {
			aborted = true;
			const message = buildAssistantMessage(plan, input.wireModelId, "", "aborted");
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			resolve({ messages: [message], exitCode: 1 });
			return;
		}

		try {
			child = spawn(plan.binary, plan.args, { env, stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[subprocess-runtime] spawn ${plan.binary} failed: ${msg}\n`);
			const message = buildAssistantMessage(plan, input.wireModelId, "", "error");
			const withError = { ...message, errorMessage: msg };
			emit({ type: "message_end", message: withError });
			emit({ type: "agent_end", messages: [withError] });
			resolve({ messages: [withError], exitCode: 1 });
			return;
		}

		const onAbort = () => {
			aborted = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// child may already be gone
			}
		};
		input.signal?.addEventListener("abort", onAbort);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		child.on("error", (err) => {
			process.stderr.write(`[subprocess-runtime] ${plan.binary} error: ${err.message}\n`);
		});

		if (plan.stdin !== undefined && child.stdin) {
			child.stdin.write(plan.stdin);
			child.stdin.end();
		} else if (child.stdin) {
			child.stdin.end();
		}

		child.on("close", (code) => {
			input.signal?.removeEventListener("abort", onAbort);
			const text = Buffer.concat(stdoutChunks).toString("utf8");
			const errText = Buffer.concat(stderrChunks).toString("utf8");
			if (errText.length > 0) {
				process.stderr.write(`[subprocess-runtime] ${plan.binary} stderr: ${errText}`);
			}
			const exitCode = code ?? 1;
			const stopReason: AssistantMessage["stopReason"] = aborted ? "aborted" : exitCode === 0 ? "stop" : "error";
			const message = buildAssistantMessage(plan, input.wireModelId, text, stopReason);
			const finalMessage =
				stopReason === "error" && errText.length > 0 ? { ...message, errorMessage: errText.trim() } : message;
			emit({ type: "message_end", message: finalMessage });
			emit({ type: "agent_end", messages: [finalMessage] });
			resolve({ messages: [finalMessage], exitCode: aborted ? 1 : exitCode });
		});
	});

	return {
		promise,
		abort: () => {
			if (!child) return;
			aborted = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// ignore; close handler still resolves
			}
		},
	};
}
