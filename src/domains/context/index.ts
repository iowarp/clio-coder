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
export { type RunBootstrapInput, type RunBootstrapResult, runBootstrap } from "./bootstrap.js";
export { type RunContextClearInput, type RunContextClearResult, runContextClear } from "./clear.js";
export { parseClioMd, serializeClioMd, tryReadClioMd } from "./clio-md.js";
export { buildCodewiki, readCodewiki, updateCodewikiPaths, writeCodewiki } from "./codewiki/indexer.js";
export type { ContextContract, ContextState, ProjectPromptContext } from "./contract.js";
export { computeFingerprint, isStale } from "./fingerprint.js";
export { readClioState, writeClioState } from "./state.js";
