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
export { createMemoryAuthStorage, openAuthStorage, resolveAuthTarget, resolveRuntimeAuthTarget } from "./auth/index.js";
export { mergeCapabilities } from "./capabilities.js";
export type { EndpointHealth, EndpointStatus, ProvidersContract } from "./contract.js";
export { ProvidersManifest } from "./manifest.js";
export { resolveModelCapabilities } from "./model-capabilities.js";
export { createRuntimeRegistry, getRuntimeRegistry } from "./registry.js";
export {
	type ResolvedModelRef,
	type ResolveModelResult,
	resolveModelReference,
	splitThinkingSuffix,
} from "./resolver.js";
export {
	buildProviderSupportEntry,
	compareProviderSupportEntries,
	configuredEndpointsForRuntime,
	defaultModelForRuntime,
	listKnownModelsForRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	type ProviderSupportGroup,
	type ResolvedProviderReference,
	resolveProviderReference,
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
export type { EndpointAuth, EndpointDescriptor, EndpointPricing } from "./types/endpoint-descriptor.js";
export type { KnowledgeBase, KnowledgeBaseEntry, KnowledgeBaseHit } from "./types/knowledge-base.js";
export type {
	ProbeContext,
	ProbeResult,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
} from "./types/runtime-descriptor.js";
