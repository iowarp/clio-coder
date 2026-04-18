/**
 * Worker-subprocess engine boundary.
 *
 * Owns the pi-agent-core Agent instance for a worker run and forwards every
 * AgentEvent to an emit callback (the worker entry serializes events to NDJSON
 * stdout). This is the ONLY module the worker entry is allowed to import when it
 * needs to touch pi-mono; everything else in src/worker/** must stay pi-mono-free.
 *
 * Phase 6 slice 1 keeps the surface intentionally small: no tool registration,
 * no transform hooks, no custom streamFn. Later slices expand WorkerRunInput as
 * the dispatch domain needs more fields. The empty `initialState.tools` is the
 * pre-tool-registration baseline; the worker will never call a tool on this run.
 */

import type { EndpointSpec } from "../core/defaults.js";
import type { ToolName } from "../core/tool-names.js";
import type { ModeName } from "../domains/modes/matrix.js";
import { getModel, registerFauxFromEnv, registerLocalProviders } from "./ai.js";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type Model } from "./types.js";
import { createWorkerToolRegistry, resolveAgentTools } from "./worker-tools.js";

export type { EndpointSpec };

export interface WorkerRunInput {
	systemPrompt: string;
	task: string;
	providerId: string;
	modelId: string;
	sessionId?: string;
	apiKey?: string;
	/** Tool ids the agent is allowed to use. Defaults to the mode matrix. */
	allowedTools?: ReadonlyArray<ToolName>;
	/** Mode matrix the worker runs under. Defaults to "default". */
	mode?: ModeName;
	/**
	 * Local-engine endpoint name. When both this and `endpointSpec` are set, the
	 * worker registers the endpoint into its in-process local-model registry
	 * before calling `getModel`, so a freshly spawned worker subprocess can
	 * resolve `${providerId}:${modelId}` for llamacpp/lmstudio/ollama/openai-compat
	 * without re-reading settings.yaml.
	 */
	endpointName?: string;
	/** EndpointSpec for the worker's single local endpoint. See `endpointName`. */
	endpointSpec?: EndpointSpec;
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

const LOCAL_WORKER_PROVIDER_IDS = new Set(["llamacpp", "lmstudio", "ollama", "openai-compat"]);

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

function seedWorkerLocalRegistry(input: Pick<WorkerRunInput, "providerId" | "endpointName" | "endpointSpec">): void {
	if (!LOCAL_WORKER_PROVIDER_IDS.has(input.providerId)) return;
	if (input.endpointName && input.endpointSpec) {
		registerLocalProviders({
			[input.providerId]: { endpoints: { [input.endpointName]: input.endpointSpec } },
		} as Parameters<typeof registerLocalProviders>[0]);
		return;
	}
	// Reused worker processes must not inherit a previous local endpoint when the
	// current run omitted bootstrap fields.
	registerLocalProviders({});
}

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const fauxModel = registerFauxFromEnv();
	seedWorkerLocalRegistry(input);
	const model = input.providerId === "faux" && fauxModel ? fauxModel : getModel(input.providerId, input.modelId);
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
			model: model as unknown as Model<never>,
			thinkingLevel: "off",
			tools,
			messages: [],
		},
		getApiKey: async (provider: string) => {
			if (input.apiKey && input.apiKey.length > 0) return input.apiKey;
			if (input.endpointSpec?.api_key && input.endpointSpec.api_key.length > 0) {
				return input.endpointSpec.api_key;
			}
			return process.env[`${provider.toUpperCase()}_API_KEY`];
		},
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
