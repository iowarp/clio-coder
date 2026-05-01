import type { DomainModule } from "../../core/domain-loader.js";
import { createContextBundle } from "./extension.js";
import { ContextManifest } from "./manifest.js";

export const ContextDomainModule: DomainModule = {
	manifest: ContextManifest,
	createExtension: createContextBundle,
};

export { type RunBootstrapInput, type RunBootstrapResult, runBootstrap } from "./bootstrap.js";
export { parseClioMd, serializeClioMd, tryReadClioMd } from "./clio-md.js";
export { buildCodewiki, readCodewiki, writeCodewiki } from "./codewiki/indexer.js";
export type { ContextContract, ProjectPromptContext } from "./contract.js";
export { computeFingerprint, isStale } from "./fingerprint.js";
export { readClioState, writeClioState } from "./state.js";
