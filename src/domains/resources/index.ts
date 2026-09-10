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
export type { ResourceList, ResourcesContract } from "./contract.js";
export {
	classifyLibraryRequirements,
	commitLibraryInstallPlan,
	confirmLibraryRemote,
	discoverLibrary,
	installLibraryPlan,
	type LibraryCommandRunner,
	type LibraryDiscoveryResult,
	type LibraryEntry,
	type LibraryInstallPlan,
	type LibraryRequirementStatus,
	libraryEntryDrift,
	libraryEntryInstalled,
	libraryEntryPin,
	libraryEntryRef,
	libraryInstallPath,
	pinLibraryEntry,
	planLibraryInstall,
	planLibraryUpdate,
	releaseLibraryPlan,
	removeLibraryEntry,
	resolveLibraryPackage,
	resolveLibraryRequirements,
	syncLibrary,
} from "./library.js";
export {
	applyLibraryLifecycle,
	type LibraryApplyResult,
	type LibraryExpectedCopy,
	type LibraryLifecyclePlan,
	type LibraryLifecycleRequest,
	type LibraryOperation,
	type LibraryPackageIdentity,
	type LibraryPlanStep,
	type LibraryRefreshHost,
	type LibraryRefreshResult,
	type LibraryStepOutcome,
	type LibraryStepStatus,
	type LibraryStepVerification,
	libraryImportOutcome,
	libraryLifecyclePlanSummary,
	planLibraryLifecycle,
	pluginSnapshotRefreshHost,
	releaseLibraryLifecycle,
	retryLibraryRefresh,
	verifyLibraryStep,
} from "./library-actions.js";
export {
	classifyLibraryOrigin,
	inspectLibraryCopy,
	LIBRARY_INVENTORY_LIMITS,
	type LibraryCopy,
	type LibraryCopyInspection,
	type LibraryCopyState,
	type LibraryInventory,
	type LibraryInventoryOptions,
	type LibraryOrigin,
	type LibraryOriginEvidence,
	type LibraryPackageFormat,
	type LibraryPackageRecord,
	type LibraryResource,
	type LibraryResourceAvailability,
	type LibraryResourceKeyParts,
	type LibraryResourceSourceClass,
	libraryCopyState,
	libraryResourceKey,
	parseLibraryResourceKey,
	readLibraryInventory,
} from "./library-inventory.js";
export {
	isLibraryResourceKind,
	LIBRARY_RESOURCE_KINDS,
	type LibraryProvidedResource,
	type LibraryResourceKind,
} from "./library-types.js";
export {
	type LibraryPackageValidation,
	type LibraryPackageValidationResult,
	type LibraryResourceValidationRecord,
	type LibraryValidationDiagnostic,
	type LibraryValidationPrerequisite,
	type LibraryValidationSeverity,
	validateLibraryPackage,
} from "./library-validation.js";
export { createResourcesLoader, type ResourceLoaderOptions } from "./loader.js";
export { ResourcesManifest } from "./manifest.js";
export {
	expandPromptTemplateInput,
	loadPromptTemplates,
	type PromptTemplate,
	type PromptTemplateExpansion,
	type PromptTemplateList,
	type PromptTemplateRoot,
	promptTemplateDisplayText,
} from "./prompts/loader.js";
export { parseCommandArgs, substituteArgs } from "./prompts/substitute.js";
export { parseSkillEvals, type SkillEvalParseResult, type SkillEvalScenario } from "./skills/evals.js";
export {
	type InstallSkillInput,
	type InstallSkillResult,
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
	type LoadSkillsInput,
	loadSkills,
	modelVisibleSkills,
	parsePendingSkillRequests,
	parseSkillCommand,
	SKILL_SURFACE_CLEAR_ARG,
	type Skill,
	type SkillCatalogInvalidReason,
	type SkillCatalogValidity,
	type SkillExpansion,
	type SkillList,
	type SkillProvenance,
	type SkillRoot,
	type SkillSource,
	skillCatalogValidity,
} from "./skills/loader.js";
export {
	type DiscoverMarketplaceOptions,
	discoverMarketplaceSkills,
	getMarketplaceSkills,
	installSkill,
	type LibraryEntryKind,
	type LibraryRequirementRef,
	MARKETPLACE_UNCONFIGURED,
	type MarketplaceDiscoveryResult,
	type MarketplaceSkill,
	type MarketplaceSkillOrigin,
	type MarketplaceStatus,
	marketplaceInstallShaping,
	resolveMarketplaceShaping,
} from "./skills/marketplace.js";
export {
	checkSkillDrift,
	type SkillDriftVerdict,
	type SkillPinEntry,
} from "./skills/provenance-pin.js";
