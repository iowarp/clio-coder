/**
 * An agent profile identifies whether an agent loop is running as the orchestrator
 * (full tool registry, manages workers) or as a worker (restricted tool set, produces
 * a single result for the orchestrator).
 */

export const AgentProfiles = {
	Orchestrator: "orchestrator",
	Worker: "worker",
} as const;

export type AgentProfile = (typeof AgentProfiles)[keyof typeof AgentProfiles];
