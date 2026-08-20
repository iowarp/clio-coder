/**
 * Thin wrapper over Clio's engine Agent class.
 *
 * The engine Agent owns its own state (exposed via `agent.state`). There is no
 * separate state factory. AgentOptions drives the construction; the state is derived
 * from options.initialState on instantiation.
 *
 * pi-agent-core 0.84 requires an explicit stream function on every agent.
 * Clio's default is the compat `streamSimple` dispatcher (the same function the
 * pre-0.81 engine used implicitly); callers may override it for tests.
 */

import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { engineStreamSimple } from "./api-registry.js";

export type EngineAgentOptions = Omit<AgentOptions, "streamFn"> & { streamFn?: StreamFn };

export interface EngineAgentHandle {
	agent: Agent;
	state(): Agent["state"];
}

export function createEngineAgent(options: EngineAgentOptions = {}): EngineAgentHandle {
	const agent = new Agent({ streamFn: engineStreamSimple, ...options });
	return {
		agent,
		state: () => agent.state,
	};
}
