import type { DomainModule } from "../../core/domain-loader.js";
import { type ContextBundleOptions, createContextBundle } from "./extension.js";
import { ContextManifest } from "./manifest.js";

export const ContextDomainModule: DomainModule = {
	manifest: ContextManifest,
	createExtension: createContextBundle,
};

export function createContextDomainModule(options: ContextBundleOptions = {}): DomainModule {
	return {
		manifest: ContextManifest,
		createExtension: (context) => createContextBundle(context, options),
	};
}

export {
	type AdoptionScanResult,
	adoptionSnapshotsHash,
	adoptionSourcesChanged,
	renderImportedAgentContext,
	scanAgentConfigs,
} from "./adoption.js";
export {
	type BootstrapFallbackMode,
	type BootstrapFallbackResult,
	type BootstrapGenerate,
	type BootstrapGenerateInput,
	type BootstrapProgressEvent,
	type BootstrapProgressSink,
	type BootstrapStructuredOutput,
	existingClioMdBootstrapOutput,
	fallbackBootstrapOutput,
	type RunBootstrapInput,
	type RunBootstrapResult,
	runBootstrap,
} from "./bootstrap.js";
export { type RunContextClearInput, type RunContextClearResult, runContextClear } from "./clear.js";
export { parseClioMd, serializeClioMd, tryReadClioMd } from "./clio-md.js";
export { renderCodewikiDigest } from "./codewiki/digest.js";
export {
	buildCodewiki,
	codewikiEntries,
	codewikiNeedsBackfill,
	readCodewiki,
	structuralCodewikiHash,
	updateCodewikiPaths,
	writeCodewiki,
} from "./codewiki/indexer.js";
export type { ContextContract, ContextState, ProjectPromptContext, ProjectStructuredContext } from "./contract.js";
export { computeFingerprint, isStale } from "./fingerprint.js";
export {
	type LoadedOperatorProfile,
	loadOperatorProfile,
	OPERATOR_PROFILE_MAX_CHARS,
	type OperatorProfile,
	renderOperatorProfile,
} from "./operator-profile.js";
export {
	loadProjectRules,
	type ProjectRule,
	type ProjectRulesLoad,
	selectActiveRules,
} from "./project-rules.js";
export { renderPromptContext } from "./prompt-context.js";
export {
	type RunContextRefreshInput,
	type RunContextRefreshResult,
	runContextRefresh,
} from "./refresh.js";
export { readClioState, writeClioState } from "./state.js";
export {
	type RunWikiGenerateInput,
	type RunWikiGenerateResult,
	runWikiGenerate,
	type WikiGenerate,
	type WikiGenerateInput,
	type WikiGenerateMode,
} from "./wiki/generate.js";
export { listWikiPages, validateWikiLayout, type WikiLayoutValidation, type WikiPage, wikiDir } from "./wiki/layout.js";
export {
	computeWikiContentHash,
	currentWikiGitHead,
	isWikiMeta,
	readWikiMeta,
	validateWikiMeta,
	type WikiMeta,
	type WikiMetaValidation,
	wikiMetaPath,
	writeWikiMeta,
} from "./wiki/meta.js";
export { type BuildWikiPromptInput, buildWikiPrompt } from "./wiki/prompts.js";
export { type WikiStaleness, wikiStaleness } from "./wiki/staleness.js";
