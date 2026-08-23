import type { DomainModule } from "../../core/domain-loader.js";
import type { ProvidersContract } from "./contract.js";
import { createProvidersBundle } from "./extension.js";
import { ProvidersManifest } from "./manifest.js";

export const ProvidersDomainModule: DomainModule<ProvidersContract> = {
	manifest: ProvidersManifest,
	createExtension: createProvidersBundle,
};

export type {
	ApiKeyCredential,
	AuthCredential,
	AuthResolution,
	AuthStatus,
	AuthTarget,
	OAuthCredential,
} from "./auth/index.js";
export {
	authNotRequiredStatus,
	createMemoryAuthStorage,
	openAuthStorage,
	resolveAuthTarget,
	resolveRuntimeAuthTarget,
	targetRequiresAuth,
} from "./auth/index.js";
export { AGENT_ROLE_TOOLS_REQUIRED_REASON, mergeCapabilities, supportsAgentRoleTools } from "./capabilities.js";
export type { ProvidersContract, TargetHealth, TargetStatus } from "./contract.js";
export { isDispatchEligibleRuntime, isOrchestratorEligibleRuntime, isTargetEligibleRuntime } from "./eligibility.js";
export { ProvidersManifest } from "./manifest.js";
export type { ModelCapabilityPatchTarget } from "./model-capabilities.js";
export { applyModelCapabilityPatch, resolveModelCapabilities } from "./model-capabilities.js";
export {
	canonicalizeWireModelId,
	contextSlotsForModel,
	hasLiveModelCatalog,
	loadedContextWindowForModel,
	type ModelResidency,
	modelCandidatesForStatus,
	modelIdsForStatus,
	modelLoadStateLabel,
	modelResidencyForStatus,
	type ProviderModelCandidate,
	type ProviderModelSource,
} from "./model-discovery.js";
export {
	inferLocalModelFamily,
	isHarmonyModelId,
	type LocalModelFamily,
	normalizeModelIdForFamily,
} from "./model-family.js";
export {
	type AppliedThinking,
	type AppliedThinkingNoticeKind,
	applyThinkingMechanism,
	coerceThinkingLevelForRuntime,
	effectiveThinkingLevel,
	harmonyReasoningEffort,
	inferThinkingMechanism,
	isHarmonyThinkingFormat,
	type ResolvedModelRuntimeCapabilities,
	type ResolvedRequestCapability,
	type ResolvedResponseCapability,
	type ResolvedThinkingCapability,
	type ResponseParserKind,
	resolveModelRuntimeCapabilities,
	resolveModelRuntimeCapabilitiesForModel,
	resolveModelRuntimeCapabilitiesForProviders,
	resolveModelRuntimeCapabilitiesForStatus,
	resolveTargetRuntimeCapabilities,
	restrictThinkingLevelsByMechanism,
	sortedSupportedThinkingLevels,
	supportedThinkingLevelLabels,
	type ThinkingBudgetEnforcement,
	thinkingLevelChoiceLabel,
	thinkingLevelDisplayWord,
	thinkingLevelFromChoiceLabel,
} from "./model-runtime-capabilities.js";
export { createRuntimeRegistry, getRuntimeRegistry } from "./registry.js";
export {
	type ResolvedModelRef,
	type ResolveModelResult,
	resolveModelReference,
	splitThinkingSuffix,
} from "./resolver.js";
export {
	type ContextWindowDetails,
	type ContextWindowSource,
	firstRuntimeResolutionError,
	type ResolvedRuntimeTarget,
	type RuntimeCapabilityDecision,
	type RuntimeResolutionDiagnostic,
	type RuntimeResolutionSeverity,
	type RuntimeResolutionUse,
	type RuntimeTargetResolution,
	type RuntimeTargetSnapshot,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
	runtimeResolutionWarnings,
	runtimeResolutionWarningsBesideThinkingNotice,
	runtimeTargetSnapshot,
} from "./runtime-resolution.js";
export {
	buildProviderSupportEntry,
	compareProviderSupportEntries,
	configuredTargetsForRuntime,
	defaultModelForRuntime,
	describeRuntimeModels,
	listKnownModelsForRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	type ProviderSupportGroup,
	type ResolvedProviderReference,
	type RuntimeModelListSource,
	resolveProviderReference,
	runtimeModelListSource,
	supportGroupLabel,
} from "./support.js";
export type {
	CapabilityFlags,
	StructuredOutputMode,
	ThinkingFormat,
	ThinkingLevel,
	ToolCallFormat,
} from "./types/capability-flags.js";
export {
	availableThinkingLevels,
	EMPTY_CAPABILITIES,
	VALID_THINKING_LEVELS,
} from "./types/capability-flags.js";
export { type ContextWindowSlots, formatContextWindowSlots } from "./types/context-window-slots.js";
export { type CostProvenance, normalizeCostProvenance } from "./types/cost-provenance.js";
export type { KnowledgeBase, KnowledgeBaseEntry, KnowledgeBaseHit } from "./types/knowledge-base.js";
export type {
	ProbeContext,
	ProbeModelLoadState,
	ProbeModelStatus,
	ProbeResult,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
	RuntimeTier,
} from "./types/runtime-descriptor.js";
export type { TargetAuth, TargetDescriptor, TargetPricing } from "./types/target-descriptor.js";
