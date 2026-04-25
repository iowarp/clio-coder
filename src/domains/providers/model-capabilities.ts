import { mergeCapabilities } from "./capabilities.js";
import { capabilitiesFromCatalogModel, getCatalogModelForRuntime } from "./catalog.js";
import type { EndpointStatus } from "./contract.js";
import { type CapabilityFlags, EMPTY_CAPABILITIES } from "./types/capability-flags.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";

function normalizedModelId(wireModelId: string | null | undefined): string | null {
	const trimmed = wireModelId?.trim();
	return trimmed ? trimmed : null;
}

export interface ResolveModelCapabilitiesOptions {
	/**
	 * Per-(endpoint, model) reasoning detection result, typically supplied by
	 * `providers.getDetectedReasoning(endpointId, modelId)`. When true, the
	 * returned caps mark `reasoning = true` even if the runtime defaults,
	 * knowledge-base entry, and probe-discovered caps would not. Null leaves
	 * the merged value untouched.
	 */
	detectedReasoning?: boolean | null;
}

/**
 * Resolve the effective capability set for one endpoint/model pair.
 *
 * EndpointStatus stores a merged endpoint-level view in `capabilities`, which
 * is adequate for health/readiness, but the model picker and thinking controls
 * need the selected row's own knowledge-base hit. When `probeCapabilities` is
 * present, rebuild the stack as:
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
export function resolveModelCapabilities(
	status: Pick<EndpointStatus, "endpoint" | "runtime" | "capabilities" | "probeCapabilities">,
	wireModelId: string | null | undefined,
	knowledgeBase: KnowledgeBase | null,
	options?: ResolveModelCapabilitiesOptions,
): CapabilityFlags {
	const detectedReasoning = options?.detectedReasoning ?? null;
	const applyDetected = (caps: CapabilityFlags): CapabilityFlags =>
		detectedReasoning === true ? { ...caps, reasoning: true } : caps;

	if (!status.runtime) return applyDetected(status.capabilities);
	const modelId = normalizedModelId(wireModelId) ?? normalizedModelId(status.endpoint.defaultModel);
	const baseCapabilities = capabilitiesFromCatalogModel(
		status.runtime.defaultCapabilities ?? EMPTY_CAPABILITIES,
		modelId ? getCatalogModelForRuntime(status.runtime.id, modelId) : undefined,
	);
	if (status.probeCapabilities === undefined) {
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
			status.probeCapabilities ?? null,
			status.endpoint.capabilities ?? null,
		),
	);
}
