import type { DomainModule } from "../../core/domain-loader.js";
import type { ProvidersContract } from "./contract.js";
import { createProvidersBundle } from "./extension.js";
import { ProvidersManifest } from "./manifest.js";

export const ProvidersDomainModule: DomainModule<ProvidersContract> = {
	manifest: ProvidersManifest,
	createExtension: createProvidersBundle,
};

export { ProvidersManifest } from "./manifest.js";
export type { EndpointHealth, EndpointStatus, ProvidersContract } from "./contract.js";
export type {
	ApiKeyCredential,
	AuthCredential,
	AuthResolution,
	AuthStatus,
	AuthTarget,
	OAuthCredential,
} from "./auth/index.js";
export type { EndpointAuth, EndpointDescriptor, EndpointPricing } from "./types/endpoint-descriptor.js";
export type {
	ProbeContext,
	ProbeResult,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
} from "./types/runtime-descriptor.js";
export type {
	CapabilityFlags,
	StructuredOutputMode,
	ThinkingFormat,
	ThinkingLevel,
	ToolCallFormat,
} from "./types/capability-flags.js";
export type { KnowledgeBase, KnowledgeBaseEntry, KnowledgeBaseHit } from "./types/knowledge-base.js";
export {
	EMPTY_CAPABILITIES,
	VALID_THINKING_LEVELS,
	availableThinkingLevels,
} from "./types/capability-flags.js";
export { createMemoryAuthStorage, openAuthStorage, resolveAuthTarget, resolveRuntimeAuthTarget } from "./auth/index.js";
export { createRuntimeRegistry, getRuntimeRegistry } from "./registry.js";
export { mergeCapabilities } from "./capabilities.js";
export {
	buildProviderSupportEntry,
	compareProviderSupportEntries,
	configuredEndpointsForRuntime,
	defaultModelForRuntime,
	listKnownModelsForRuntime,
	listProviderSupportEntries,
	resolveProviderReference,
	supportGroupLabel,
	type ProviderSupportEntry,
	type ProviderSupportGroup,
	type ResolvedProviderReference,
} from "./support.js";
