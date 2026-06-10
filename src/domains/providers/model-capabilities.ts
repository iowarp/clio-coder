import { mergeCapabilities } from "./capabilities.js";
import { capabilitiesFromCatalogModel, getCatalogModelForRuntime } from "./catalog.js";
import type { EndpointStatus } from "./contract.js";
import { type CapabilityFlags, EMPTY_CAPABILITIES } from "./types/capability-flags.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";

function normalizedModelId(wireModelId: string | null | undefined): string | null {
	const trimmed = wireModelId?.trim();
	return trimmed ? trimmed : null;
}

export interface ModelCapabilityPatchTarget {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

/**
 * Apply the small mutable capability surface pi-ai reads from model objects.
 * Runtime synthesis returns immutable-ish catalog objects, but live probes can
 * refine context/output/reasoning after synthesis. Keeping the mutation in one
 * helper makes those refinements explicit and avoids ad-hoc casts at call sites.
 */
export function applyModelCapabilityPatch<T extends ModelCapabilityPatchTarget>(
	model: T,
	caps: Partial<CapabilityFlags> | null | undefined,
): T {
	if (!caps) return model;
	if (typeof caps.contextWindow === "number") model.contextWindow = caps.contextWindow;
	if (typeof caps.maxTokens === "number") model.maxTokens = caps.maxTokens;
	if (typeof caps.reasoning === "boolean") model.reasoning = caps.reasoning;
	return model;
}

export interface ResolveModelCapabilitiesOptions {
	/**
	 * Per-(endpoint, model) reasoning detection result, typically supplied by
	 * `providers.getDetectedReasoning(endpointId, modelId)`. When true or
	 * false, the returned caps preserve that exact live result. Null leaves
	 * the merged value untouched.
	 */
	detectedReasoning?: boolean | null;
}

/**
 * Resolve the effective capability set for one endpoint/model pair.
 *
 * EndpointStatus stores a merged endpoint-level view in `capabilities`, which
 * is adequate for health/readiness, but the model picker and thinking controls
 * need the selected row's own knowledge-base hit. When model-keyed
 * `probeCapabilities` are present for this same wire model, rebuild the stack as:
 *
 *   runtime defaults + knowledge-base(model) + live probe + endpoint override
 *
 * When older test doubles do not provide `probeCapabilities`, fall back to the
 * pre-merged `status.capabilities` for the endpoint-default model.
 *
 * `options.detectedReasoning` lets callers feed in a per-model reasoning probe
 * result so /thinking and the model picker reflect what the loaded model can
 * actually do, without baking the detection into the runtime defaults.
 */
type ProbeCapabilityStatus = Pick<
	EndpointStatus,
	"endpoint" | "probeCapabilities" | "probeModelCapabilities" | "probeModelId"
>;

export function probeCapabilitiesForModel(
	status: ProbeCapabilityStatus,
	wireModelId: string | null | undefined,
): Partial<CapabilityFlags> | null {
	const modelId = normalizedModelId(wireModelId) ?? normalizedModelId(status.endpoint.defaultModel);
	if (!modelId) return null;
	const exact = status.probeModelCapabilities?.[modelId];
	if (exact) return exact;
	const probeModelId = normalizedModelId(status.probeModelId);
	if (probeModelId !== null) return probeModelId === modelId ? (status.probeCapabilities ?? null) : null;
	const defaultModelId = normalizedModelId(status.endpoint.defaultModel);
	return defaultModelId !== null && defaultModelId === modelId ? (status.probeCapabilities ?? null) : null;
}

export function resolveModelCapabilities(
	status: Pick<
		EndpointStatus,
		"endpoint" | "runtime" | "capabilities" | "probeCapabilities" | "probeModelCapabilities" | "probeModelId"
	>,
	wireModelId: string | null | undefined,
	knowledgeBase: KnowledgeBase | null,
	options?: ResolveModelCapabilitiesOptions,
): CapabilityFlags {
	const detectedReasoning = options?.detectedReasoning ?? null;
	const applyDetected = (caps: CapabilityFlags): CapabilityFlags =>
		detectedReasoning === null ? caps : { ...caps, reasoning: detectedReasoning };

	if (!status.runtime) return applyDetected(status.capabilities);
	const modelId = normalizedModelId(wireModelId) ?? normalizedModelId(status.endpoint.defaultModel);
	const baseCapabilities = capabilitiesFromCatalogModel(
		status.runtime.defaultCapabilities ?? EMPTY_CAPABILITIES,
		modelId ? getCatalogModelForRuntime(status.runtime.id, modelId) : undefined,
	);
	const hasModernProbeFields = status.probeCapabilities !== undefined || status.probeModelCapabilities !== undefined;
	if (!hasModernProbeFields) {
		if (!modelId || modelId === normalizedModelId(status.endpoint.defaultModel)) {
			return applyDetected(status.capabilities);
		}
		const kbHit = knowledgeBase?.lookup(modelId) ?? null;
		return applyDetected(
			mergeCapabilities(baseCapabilities, kbHit?.entry.capabilities ?? null, null, status.endpoint.capabilities ?? null),
		);
	}
	const kbHit = modelId ? (knowledgeBase?.lookup(modelId) ?? null) : null;
	return applyDetected(
		mergeCapabilities(
			baseCapabilities,
			kbHit?.entry.capabilities ?? null,
			probeCapabilitiesForModel(status, modelId),
			status.endpoint.capabilities ?? null,
		),
	);
}
