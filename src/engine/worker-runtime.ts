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

import { getModel, registerFauxFromEnv } from "./ai.js";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type Model } from "./types.js";

export interface WorkerRunInput {
	systemPrompt: string;
	task: string;
	providerId: string;
	modelId: string;
	sessionId?: string;
	apiKey?: string;
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

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	registerFauxFromEnv();

	const model = getModel(input.providerId, input.modelId);
	const options: AgentOptions = {
		initialState: {
			systemPrompt: input.systemPrompt,
			model: model as unknown as Model<never>,
			thinkingLevel: "off",
			tools: [],
			messages: [],
		},
		getApiKey: async (provider: string) => {
			if (input.apiKey && input.apiKey.length > 0) return input.apiKey;
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
			return { messages: agent.state.messages, exitCode: 0 };
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
