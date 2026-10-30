/**
 * Gateways that route every model to its own backend deployment. Behind one of
 * these the scheduler that owns a request's slot is that model's backend, not
 * the gateway URL: live, the main agent streaming qwopus (dynamo) through the
 * same `litellm` target marked memory's ornith (mini) busy and dropped 12 of
 * its steps per run. A generic protocol endpoint (`openai-compat`) is often a
 * single local server that answers any model name, so it keeps one key.
 *
 * A gateway's URL also cannot establish the selected model's locality, even on
 * a private network (#429).
 */
const MODEL_ROUTED_GATEWAY_RUNTIMES: ReadonlySet<string> = new Set(["litellm", "openrouter"]);

export function isModelRoutedGatewayRuntime(runtimeId: string): boolean {
	return MODEL_ROUTED_GATEWAY_RUNTIMES.has(runtimeId);
}
