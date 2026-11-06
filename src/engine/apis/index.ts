import { registerEngineSessionCleanup } from "../ai.js";
import { registerEngineApiProvider } from "../api-registry.js";
import { copilotSdkApiProvider, disposeCopilotConversations } from "../copilot/stream.js";
import { ollamaNativeApiProvider } from "./ollama-native.js";
import { openAICompletionsApiProvider } from "./openai-completions.js";

export { ollamaNativeApiProvider } from "./ollama-native.js";
export { openAICompletionsApiProvider } from "./openai-completions.js";
export { setGlobalDefaultMaxOutputTokens } from "./output-budget.js";

let registered = false;

export function registerClioApiProviders(): void {
	if (registered) return;
	registered = true;
	registerEngineApiProvider(openAICompletionsApiProvider, "clio");
	registerEngineApiProvider(ollamaNativeApiProvider, "clio");
	registerEngineApiProvider(copilotSdkApiProvider, "clio");
	// A call without a session id used the "default" conversation key.
	registerEngineSessionCleanup((sessionId) => disposeCopilotConversations(sessionId ?? "default"));
}
