export {
	type AdoptionScanResult,
	type AdoptionSourcesChangedOptions,
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
	type BootstrapGenerationSink,
	type BootstrapGenerationTelemetry,
	type BootstrapProgressEvent,
	type BootstrapProgressSink,
	type BootstrapRunTelemetry,
	type BootstrapStructuredOutput,
	fallbackBootstrapOutput,
	type RunBootstrapInput,
	type RunBootstrapResult,
	runBootstrap,
} from "./bootstrap.js";
export { type RunContextClearInput, type RunContextClearResult, runContextClear } from "./clear.js";
export { loadProjectClioMd, parseClioMd, serializeClioMd, tryReadClioMd } from "./clio-md.js";
export {
	codewikiEntries,
	codewikiNeedsBackfill,
	codewikiPath,
	parseCodewikiRaw,
	readCodewiki,
	readCodewikiAsync,
	serializeCodewiki,
	structuralCodewikiHash,
	writeCodewiki,
} from "./codewiki/artifact.js";
export { type CooperativeSlicer, createSlicer, INDEX_SLICE_MS } from "./codewiki/cooperative.js";
export { renderCodewikiDigest } from "./codewiki/digest.js";
export {
	buildCodewiki,
	syncCodewiki,
	updateCodewikiPaths,
} from "./codewiki/indexer.js";
export { CODEWIKI_VERSION } from "./codewiki/schema.js";
export type { ContextContract, ContextState, ProjectPromptContext, ProjectStructuredContext } from "./contract.js";
export {
	type ComputeFingerprintAsyncOptions,
	computeFingerprint,
	computeFingerprintAsync,
	isStale,
} from "./fingerprint.js";
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
export { type ContextBundleOptions, ContextDomainModule, createContextDomainModule } from "./runtime.js";
export {
	type BootstrapGenerationMode,
	type BootstrapGenerationState,
	type BootstrapParserOutcome,
	readClioState,
	writeClioState,
} from "./state.js";
export { assembleWikiTree, type WikiAssemblyReport, type WikiPageIssue } from "./wiki/assemble.js";
export {
	readWikiPage,
	renderWikiPage,
	type WikiPageDocument,
	type WikiPageMetadata,
} from "./wiki/frontmatter.js";
export {
	type RunWikiGenerateInput,
	type RunWikiGenerateResult,
	runWikiGenerate,
	type WikiGenerate,
	type WikiGenerateInput,
	type WikiGenerateMode,
} from "./wiki/generate.js";
export {
	isGeneratedWikiFile,
	listWikiPages,
	listWikiPagesInDir,
	WIKI_INDEX,
	WIKI_PLAN_FILE,
	WIKI_QUICKSTART,
	type WikiPage,
	wikiDir,
	wikiMarkdownFilesInDir,
} from "./wiki/layout.js";
export {
	computeWikiContentHash,
	computeWikiContentHashOfDir,
	currentWikiGitHead,
	isWikiMeta,
	readWikiMeta,
	validateWikiMeta,
	type WikiMeta,
	type WikiMetaGeneration,
	type WikiMetaValidation,
	wikiMetaPath,
	writeWikiMeta,
} from "./wiki/meta.js";
export {
	buildCandidatePlan,
	type DepthStrategy,
	pagePathForArea,
	planWikiGeneration,
	type ResolvedWikiDepth,
	WIKI_DEPTH_STRATEGY,
	type WikiDepth,
	type WikiGenerationPlan,
	type WikiPlan,
	type WikiPlanPage,
} from "./wiki/plan.js";
export {
	MAX_PAGE_ATTEMPTS,
	pendingPages,
	readWikiPlanFile,
	sanitizePagePath,
	sanitizeWikiPlan,
	scopePlanForUpdate,
	writeWikiPlanFile,
} from "./wiki/plan-store.js";
export {
	type BuildWikiPagePromptInput,
	type BuildWikiPlanPromptInput,
	buildWikiPagePrompt,
	buildWikiPlanPrompt,
} from "./wiki/prompts.js";
export {
	changedPathsSince,
	type WikiCompleteness,
	type WikiStaleness,
	wikiCompleteness,
	wikiCompletenessFromMeta,
	wikiStaleness,
	wikiStalenessAsync,
} from "./wiki/staleness.js";
