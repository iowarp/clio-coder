import type { RuntimeAdapter } from "../runtime-contract.js";
import { anthropicAdapter } from "./anthropic.js";
import { bedrockAdapter } from "./bedrock.js";
import { CLI_ADAPTERS } from "./cli/index.js";
import { googleAdapter } from "./google.js";
import { groqAdapter } from "./groq.js";
import { localAdapter } from "./local.js";
import { mistralAdapter } from "./mistral.js";
import { openaiAdapter } from "./openai.js";
import { openrouterAdapter } from "./openrouter.js";

export { anthropicAdapter } from "./anthropic.js";
export { bedrockAdapter } from "./bedrock.js";
export { googleAdapter } from "./google.js";
export { groqAdapter } from "./groq.js";
export { localAdapter } from "./local.js";
export { mistralAdapter } from "./mistral.js";
export { openaiAdapter } from "./openai.js";
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
	localAdapter,
];

export const RUNTIME_ADAPTERS: ReadonlyArray<RuntimeAdapter> = [...PROVIDER_ADAPTERS, ...CLI_ADAPTERS];
