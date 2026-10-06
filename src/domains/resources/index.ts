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
	resolveLibraryPackage,
	resolveLibraryRequirements,
	syncLibrary,
} from "./library.js";
export {
	applyLibraryLifecycle,
	type LibraryApplyResult,
	type LibraryExpectedCopy,
	type LibraryExtensionRefresh,
	type LibraryLifecyclePlan,
	type LibraryLifecycleRequest,
	type LibraryOperation,
	type LibraryPackageIdentity,
	type LibraryPlanStep,
	type LibraryRefreshHost,
	type LibraryRefreshResult,
	type LibraryRefreshTouch,
	type LibraryStepOutcome,
	type LibraryStepReview,
	type LibraryStepStatus,
	type LibraryStepVerification,
	libraryImportOutcome,
	libraryRefreshTouch,
	planLibraryLifecycle,
	releaseLibraryLifecycle,
	retryLibraryRefresh,
	verifyLibraryStep,
} from "./library-actions.js";
export {
	classifyLibraryOrigin,
	inspectLibraryCopy,
	LIBRARY_INVENTORY_LIMITS,
	type LibraryComponent,
	type LibraryComponentAvailability,
	type LibraryComponentKeyParts,
	type LibraryComponentSourceClass,
	type LibraryCopy,
	type LibraryCopyInspection,
	type LibraryCopyState,
	type LibraryInventory,
	type LibraryInventoryOptions,
	type LibraryOrigin,
	type LibraryOriginEvidence,
	type LibraryPackageFormat,
	type LibraryPackageRecord,
	libraryComponentKey,
	libraryCopyState,
	parseLibraryResourceKey,
	readLibraryInventory,
} from "./library-inventory.js";
export {
	describeLibraryPair,
	type LibraryPair,
	type LibraryPairs,
	libraryPairsFrom,
	readLibraryPairs,
} from "./library-pairing.js";
export {
	isLibraryComponentKind,
	LIBRARY_COMPONENT_KINDS,
	type LibraryComponentKind,
	type LibraryProvidedResource,
} from "./library-types.js";
export {
	type LibraryComponentValidationRecord,
	type LibraryPackageValidation,
	type LibraryPackageValidationResult,
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
export { installedSkillNames, installedSkillPackages } from "./skills/availability.js";
export {
	buildSkillCatalogView,
	type SkillCatalogPackage,
	type SkillCatalogRow,
	type SkillCatalogRowKind,
	type SkillCatalogView,
	type SkillCatalogViewInput,
} from "./skills/catalog-view.js";
export {
	type InstallSkillInput,
	type InstallSkillResult,
	normalizedSkillHash,
	parseSkillSourceSpec,
	type SkillSourceSpec,
} from "./skills/install.js";
export { type LexicalMatchMode, lexicalMatches } from "./skills/lexical-match.js";
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
} from "./skills/marketplace.js";
export {
	checkSkillDrift,
	checkSkillDriftBatch,
	type SkillDriftSubject,
	type SkillDriftVerdict,
	type SkillPinEntry,
} from "./skills/provenance-pin.js";
