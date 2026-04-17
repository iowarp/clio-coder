import type { DomainModule } from "../../core/domain-loader.js";
import { createPromptsBundle } from "./extension.js";
import { PromptsManifest } from "./manifest.js";

export const PromptsDomainModule: DomainModule = {
	manifest: PromptsManifest,
	createExtension: createPromptsBundle,
};

export { PromptsManifest } from "./manifest.js";
export type { PromptsContract, CompileForTurnInput } from "./contract.js";
