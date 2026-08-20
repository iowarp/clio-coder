import { registerEngineApiProvider } from "../api-registry.js";
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
}
