import type { DomainModule } from "../../core/domain-loader.js";
import { createContextBundle } from "./extension.js";
import { ContextManifest } from "./manifest.js";

export const ContextDomainModule: DomainModule = {
	manifest: ContextManifest,
	createExtension: createContextBundle,
};

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
	buildCodewikiWithTreeSitter,
	codewikiEntries,
	readCodewiki,
	structuralCodewikiHash,
	updateCodewikiPaths,
	writeCodewiki,
} from "./codewiki/indexer.js";
export type { ContextContract, ContextState, ProjectPromptContext } from "./contract.js";
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
export { readClioState, writeClioState } from "./state.js";
