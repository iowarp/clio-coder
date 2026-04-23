/**
 * Worker-subprocess engine boundary.
 *
 * Owns the pi-agent-core Agent instance for a worker run and forwards every
 * AgentEvent to an emit callback (the worker entry serializes events to NDJSON
 * stdout). Post-W5 the surface takes a resolved EndpointDescriptor +
 * RuntimeDescriptor + wire model id, not a provider/model pair. Subprocess
 * runtimes (claude-code-cli, codex-cli, gemini-cli) do not touch pi-ai; they
 * delegate to subprocess-runtime.ts which spawns the CLI agent directly.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolName } from "../core/tool-names.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type { EndpointDescriptor, RuntimeDescriptor, ThinkingLevel } from "../domains/providers/index.js";
import {
	FileKnowledgeBase,
	type KnowledgeBase,
	type KnowledgeBaseHit,
} from "../domains/providers/types/knowledge-base.js";
import { registerFauxFromEnv } from "./ai.js";
import { patchReasoningSummaryPayload } from "./provider-payload.js";
import { startSubprocessWorkerRun } from "./subprocess-runtime.js";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type Model } from "./types.js";
import { createWorkerToolRegistry, resolveAgentTools } from "./worker-tools.js";

export interface WorkerRunInput {
	sessionId?: string;
	systemPrompt: string;
	task: string;
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
	/** Tool ids the agent is allowed to use. Defaults to the mode matrix. */
	allowedTools?: ReadonlyArray<ToolName>;
	/** Mode matrix the worker runs under. Defaults to "default". */
	mode?: ModeName;
	signal?: AbortSignal;
}

export interface WorkerRunResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface WorkerRunHandle {
	promise: Promise<WorkerRunResult>;
	abort(): void;
}

export type WorkerEventEmit = (event: AgentEvent) => void;

function isAssistantMessage(
	message: AgentMessage | undefined,
): message is AgentMessage & { role: "assistant"; stopReason?: string; errorMessage?: string } {
	if (typeof message !== "object" || message === null) return false;
	return "role" in message && message.role === "assistant";
}

function getTerminalAgentError(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isAssistantMessage(message)) continue;
		if (message.stopReason !== "error") return null;
		return typeof message.errorMessage === "string" ? message.errorMessage : "";
	}
	return null;
}

class NullKnowledgeBase implements KnowledgeBase {
	lookup(_modelId: string): KnowledgeBaseHit | null {
		return null;
	}
	entries() {
		return [];
	}
}

let kbSingleton: KnowledgeBase | null = null;

function getKnowledgeBase(): KnowledgeBase {
	if (kbSingleton) return kbSingleton;
	try {
		const dir = fileURLToPath(new URL("../domains/providers/models/", import.meta.url));
		kbSingleton = existsSync(dir) ? new FileKnowledgeBase(dir) : new NullKnowledgeBase();
	} catch {
		kbSingleton = new NullKnowledgeBase();
	}
	return kbSingleton;
}

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const fauxModel = registerFauxFromEnv();

	if (input.runtime.kind === "subprocess") {
		const subprocessInput: Parameters<typeof startSubprocessWorkerRun>[0] = {
			systemPrompt: input.systemPrompt,
			task: input.task,
			endpoint: input.endpoint,
			runtime: input.runtime,
			wireModelId: input.wireModelId,
		};
		if (input.apiKey !== undefined) subprocessInput.apiKey = input.apiKey;
		if (input.signal !== undefined) subprocessInput.signal = input.signal;
		return startSubprocessWorkerRun(subprocessInput, emit);
	}

	const kb = getKnowledgeBase();
	const kbHit = kb.lookup(input.wireModelId);
	const synthesized = input.runtime.synthesizeModel(input.endpoint, input.wireModelId, kbHit);
	const model = input.endpoint.runtime === "faux" && fauxModel ? fauxModel : (synthesized as unknown as Model<never>);

	const mode: ModeName = input.mode ?? "default";
	const registry = createWorkerToolRegistry(mode);
	const tools = resolveAgentTools({
		registry,
		mode,
		...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
	});
	if (tools.length === 0 && (input.allowedTools?.length ?? 0) > 0) {
		process.stderr.write(
			`[worker] warning: no tools resolved for mode=${mode} allowed=[${(input.allowedTools ?? []).join(",")}]\n`,
		);
	}

	const options: AgentOptions = {
		initialState: {
			systemPrompt: input.systemPrompt,
			model,
			thinkingLevel: input.thinkingLevel ?? "off",
			tools,
			messages: [],
		},
		onPayload: async (payload, currentModel) =>
			patchReasoningSummaryPayload(payload, currentModel as Model<never>, input.thinkingLevel ?? "off"),
		getApiKey: async () => input.apiKey,
	};
	if (input.sessionId) options.sessionId = input.sessionId;

	const agent = new Agent(options);
	const unsubscribe = agent.subscribe(async (event) => {
		emit(event);
	});

	const promise = (async (): Promise<WorkerRunResult> => {
		try {
			await agent.prompt(input.task);
			await agent.waitForIdle();
			unsubscribe();
			const messages = agent.state.messages;
			const errorMessage = getTerminalAgentError(messages);
			if (errorMessage !== null) {
				if (errorMessage.length > 0) {
					process.stderr.write(`[worker] agent ended with stopReason=error: ${errorMessage}\n`);
				}
				return { messages, exitCode: 1 };
			}
			return { messages, exitCode: 0 };
		} catch (err) {
			unsubscribe();
			const msg = err instanceof Error ? err.message : String(err);
			emit({ type: "agent_end", messages: agent.state.messages });
			process.stderr.write(`[worker] agent error: ${msg}\n`);
			return { messages: agent.state.messages, exitCode: 1 };
		}
	})();

	return {
		promise,
		abort: () => agent.abort(),
	};
}
