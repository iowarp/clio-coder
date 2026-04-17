import type { RuntimeAdapter } from "../runtime-contract.js";
import { anthropicAdapter } from "./anthropic.js";
import { bedrockAdapter } from "./bedrock.js";
import { claudeSdkAdapter } from "./claude-sdk.js";
import { CLI_ADAPTERS } from "./cli/index.js";
import { googleAdapter } from "./google.js";
import { groqAdapter } from "./groq.js";
import { llamacppAdapter } from "./llamacpp.js";
import { lmstudioAdapter } from "./lmstudio.js";
import { localAdapter } from "./local.js";
import { mistralAdapter } from "./mistral.js";
import { ollamaAdapter } from "./ollama.js";
import { openaiCompatAdapter } from "./openai-compat.js";
import { openaiAdapter } from "./openai.js";
import { openrouterAdapter } from "./openrouter.js";

export { anthropicAdapter } from "./anthropic.js";
export { bedrockAdapter } from "./bedrock.js";
export { claudeSdkAdapter } from "./claude-sdk.js";
export { googleAdapter } from "./google.js";
export { groqAdapter } from "./groq.js";
export { llamacppAdapter } from "./llamacpp.js";
export { lmstudioAdapter } from "./lmstudio.js";
export { localAdapter } from "./local.js";
export { mistralAdapter } from "./mistral.js";
export { ollamaAdapter } from "./ollama.js";
export { openaiAdapter } from "./openai.js";
export { openaiCompatAdapter } from "./openai-compat.js";
export { openrouterAdapter } from "./openrouter.js";
export { CLI_ADAPTERS } from "./cli/index.js";

const PROVIDER_ADAPTERS: ReadonlyArray<RuntimeAdapter> = [
	anthropicAdapter,
	openaiAdapter,
	googleAdapter,
	groqAdapter,
	mistralAdapter,
	openrouterAdapter,
	bedrockAdapter,
	llamacppAdapter,
	lmstudioAdapter,
	ollamaAdapter,
	openaiCompatAdapter,
	localAdapter,
];

export const RUNTIME_ADAPTERS: ReadonlyArray<RuntimeAdapter> = [
	...PROVIDER_ADAPTERS,
	claudeSdkAdapter,
	...CLI_ADAPTERS,
];
