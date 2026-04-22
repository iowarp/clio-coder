/**
 * Thin wrapper over @mariozechner/pi-agent-core 0.68.1's Agent class.
 *
 * pi-agent-core's Agent owns its own state (exposed via `agent.state`). There is no
 * separate state factory. AgentOptions drives the construction; the state is derived
 * from options.initialState on instantiation.
 */

import { Agent, type AgentOptions, type AgentState } from "@mariozechner/pi-agent-core";

export interface EngineAgentHandle {
	agent: Agent;
	state(): AgentState;
}

export function createEngineAgent(options: AgentOptions = {}): EngineAgentHandle {
	const agent = new Agent(options);
	return {
		agent,
		state: () => agent.state,
	};
}
