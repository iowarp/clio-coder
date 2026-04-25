import type { DomainModule } from "../../core/domain-loader.js";
import { createPromptsBundle, type PromptsBundleOptions } from "./extension.js";
import { PromptsManifest } from "./manifest.js";

export const PromptsDomainModule: DomainModule = {
	manifest: PromptsManifest,
	createExtension: createPromptsBundle,
};

/**
 * Build a `PromptsDomainModule` with bundle options closed over the factory
 * call. Used by the orchestrator and `clio run` to thread the global
 * `--no-context-files` startup flag into the prompts domain without
 * restructuring the domain loader.
 */
export function createPromptsDomainModule(options: PromptsBundleOptions = {}): DomainModule {
	return {
		manifest: PromptsManifest,
		createExtension: (context) => createPromptsBundle(context, options),
	};
}

export type { CompileForTurnInput, PromptsContract } from "./contract.js";
export type { PromptsBundleOptions } from "./extension.js";
export { PromptsManifest } from "./manifest.js";
