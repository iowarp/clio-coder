import type { DomainModule } from "../../core/domain-loader.js";
import { createResourcesBundle } from "./extension.js";
import type { ResourceLoaderOptions } from "./loader.js";
import { ResourcesManifest } from "./manifest.js";

export const ResourcesDomainModule: DomainModule = {
	manifest: ResourcesManifest,
	createExtension: createResourcesBundle,
};

export function createResourcesDomainModule(options: ResourceLoaderOptions = {}): DomainModule {
	return {
		manifest: ResourcesManifest,
		createExtension: (context) => createResourcesBundle(context, options),
	};
}

export type { ResourceDiagnostic, ResourceScope, ResourceSourceInfo } from "./collision.js";
export { resolveResourceCollisions } from "./collision.js";
export {
	DEFAULT_CONTEXT_FILE_NAMES,
	loadProjectContextFiles,
	type ProjectContextFile,
	renderProjectContextFiles,
} from "./context-files/loader.js";
export type { ResourceList, ResourcesContract } from "./contract.js";
export { createResourcesLoader, type ResourceLoaderOptions } from "./loader.js";
export { ResourcesManifest } from "./manifest.js";
export {
	expandPromptTemplateInput,
	loadPromptTemplates,
	type PromptTemplate,
	type PromptTemplateExpansion,
	type PromptTemplateList,
	type PromptTemplateRoot,
} from "./prompts/loader.js";
export { parseCommandArgs, substituteArgs } from "./prompts/substitute.js";
export {
	type InstallSkillInput,
	type InstallSkillResult,
	installSkill,
	normalizedSkillHash,
	parseSkillSourceSpec,
	type SkillSourceSpec,
	type SkillUpdateReport,
	type SkillUpdateStatus,
	type UpdateSkillsInput,
	updateSkills,
} from "./skills/install.js";
export {
	defaultSkillRoots,
	expandSkillInvocationInput,
	formatSkillsCatalogForPrompt,
	type LoadSkillsInput,
	loadSkills,
	modelVisibleSkills,
	parsePendingSkillRequests,
	parseSkillCommand,
	type Skill,
	type SkillExpansion,
	type SkillList,
	type SkillProvenance,
	type SkillRoot,
	type SkillSource,
} from "./skills/loader.js";
export {
	type DiscoverMarketplaceOptions,
	discoverMarketplaceSkills,
	getMarketplaceSkills,
	installMarketplaceSkill,
	type MarketplaceDiscoveryResult,
	type MarketplaceSkill,
	type MarketplaceSkillOrigin,
	type MarketplaceStatus,
} from "./skills/marketplace.js";
export {
	checkSkillDrift,
	loadSkillPinManifest,
	resolveSkillPinManifestPath,
	type SkillDriftVerdict,
	type SkillPinEntry,
} from "./skills/provenance-pin.js";
