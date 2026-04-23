import { mergeCapabilities } from "./capabilities.js";
import type { EndpointStatus } from "./contract.js";
import { type CapabilityFlags, EMPTY_CAPABILITIES } from "./types/capability-flags.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";

function normalizedModelId(wireModelId: string | null | undefined): string | null {
	const trimmed = wireModelId?.trim();
	return trimmed ? trimmed : null;
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
 */
export function resolveModelCapabilities(
	status: Pick<EndpointStatus, "endpoint" | "runtime" | "capabilities" | "probeCapabilities">,
	wireModelId: string | null | undefined,
	knowledgeBase: KnowledgeBase | null,
): CapabilityFlags {
	if (!status.runtime) return status.capabilities;
	const modelId = normalizedModelId(wireModelId) ?? normalizedModelId(status.endpoint.defaultModel);
	if (status.probeCapabilities === undefined) {
		if (!modelId || modelId === normalizedModelId(status.endpoint.defaultModel)) {
			return status.capabilities;
		}
		const kbHit = knowledgeBase?.lookup(modelId) ?? null;
		return mergeCapabilities(
			status.runtime.defaultCapabilities ?? EMPTY_CAPABILITIES,
			kbHit?.entry.capabilities ?? null,
			null,
			status.endpoint.capabilities ?? null,
		);
	}
	const kbHit = modelId ? (knowledgeBase?.lookup(modelId) ?? null) : null;
	return mergeCapabilities(
		status.runtime.defaultCapabilities ?? EMPTY_CAPABILITIES,
		kbHit?.entry.capabilities ?? null,
		status.probeCapabilities ?? null,
		status.endpoint.capabilities ?? null,
	);
}
