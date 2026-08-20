/** Generic child-process attribution used by agent-aware developer tools. */
export const AI_AGENT_NAME = "clio-coder";

/** Add Clio's attribution without admitting any other environment variables. */
export function withClioAgentEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...source, AI_AGENT: AI_AGENT_NAME };
}
