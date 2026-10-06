/** Generic child-process attribution used by agent-aware developer tools. */
export const AI_AGENT_NAME = "clio-coder";

/** Add Clio's attribution without admitting any other environment variables. */
export function withClioAgentEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...source, AI_AGENT: AI_AGENT_NAME };
}

let inherited: { value: string | undefined } | undefined;

/**
 * Marks this process as Clio Coder for every child it spawns. The value it
 * inherited is kept first, because Clio marks itself unconditionally and the
 * marker would otherwise say the model ran every command.
 */
export function markClioAgentProcess(env: NodeJS.ProcessEnv = process.env): void {
	inherited ??= { value: env.AI_AGENT };
	env.AI_AGENT = AI_AGENT_NAME;
}

/** True when the environment this process started in already named Clio Coder, which means a Clio session ran the command. */
export function startedUnderClioAgent(env: NodeJS.ProcessEnv = process.env): boolean {
	return (inherited ? inherited.value : env.AI_AGENT) === AI_AGENT_NAME;
}
