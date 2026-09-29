import { hintCapabilities, mergeCapabilities } from "./capabilities.js";
import { capabilitiesFromCatalogModel, getCatalogModelForRuntime } from "./catalog.js";
import type { TargetStatus } from "./contract.js";
import { acceptsImageInput } from "./image-input.js";
import { type CapabilityFlags, EMPTY_CAPABILITIES } from "./types/capability-flags.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";
import { extractLocalModelQuirks } from "./types/local-model-quirks.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

function normalizedModelId(wireModelId: string | null | undefined): string | null {
	const trimmed = wireModelId?.trim();
	return trimmed ? trimmed : null;
}

/**
 * A runtime that reports its serving windows (`probeServingWindows`) has none
 * until the server answers. Its descriptor default, the catalog and the
 * knowledge base describe what the model allows, so none of them may stand in
 * as a ceiling the server serves. Only a live report or the operator's own
 * override keeps a window; otherwise the window is 0, which every consumer
 * reads as unknown. Returns whether the window was withheld.
 */
export function withholdUnreportedServingWindow(
	runtime: Pick<RuntimeDescriptor, "probeServingWindows"> | null | undefined,
	merged: CapabilityFlags,
	probe: Partial<CapabilityFlags> | null,
	userOverride: Partial<CapabilityFlags> | null,
): { capabilities: CapabilityFlags; withheld: boolean } {
	if (typeof runtime?.probeServingWindows !== "function") return { capabilities: merged, withheld: false };
	const reported = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0;
	if (reported(probe?.contextWindow) || reported(userOverride?.contextWindow)) {
		return { capabilities: merged, withheld: false };
	}
	return { capabilities: { ...merged, contextWindow: 0 }, withheld: merged.contextWindow !== 0 };
}

export interface ModelCapabilityPatchTarget {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	clioCoder?: Record<string, unknown>;
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
	if (typeof caps.vision === "boolean" && model.input) {
		model.input = caps.vision ? ["text", "image"] : ["text"];
	}
	// Refresh the probe-only control hints together with the capability snapshot.
	// Missing metadata after a later probe must not retain an earlier route claim.
	if (model.clioCoder || caps.thinkingControlRuntime !== undefined || caps.reasoningLevels !== undefined) {
		const metadata = { ...model.clioCoder };
		delete metadata.thinkingControlRuntime;
		delete metadata.reasoningLevels;
		if (caps.thinkingControlRuntime !== undefined) metadata.thinkingControlRuntime = caps.thinkingControlRuntime;
		if (caps.reasoningLevels !== undefined) metadata.reasoningLevels = [...caps.reasoningLevels];
		model.clioCoder = metadata;
	}
	return model;
}

export interface ResolveModelCapabilitiesOptions {
	/**
	 * Per-(target, model) reasoning detection result, typically supplied by
	 * `providers.getDetectedReasoning(targetId, modelId)`. When true or
	 * false, the returned caps preserve that exact live result. Null leaves
	 * the merged value untouched.
	 */
	detectedReasoning?: boolean | null;
}

/**
 * Reasoning precedence: an observed generation, then the server's own report, then the
 * operator's value, then the profile. `mergeCapabilities` already ranked the last three,
 * so the profile's mechanism only speaks here when neither the server nor the operator did.
 */
function applyReasoningResolution(
	caps: CapabilityFlags,
	kbHit: ReturnType<KnowledgeBase["lookup"]> | null | undefined,
	detectedReasoning: boolean | null,
	answered: boolean,
): CapabilityFlags {
	if (detectedReasoning !== null) return { ...caps, reasoning: detectedReasoning };
	if (answered) return caps;
	const mechanism = extractLocalModelQuirks(kbHit?.entry.quirks)?.thinking?.mechanism;
	if (mechanism === "none") return { ...caps, reasoning: false };
	if (mechanism === "always-on") return { ...caps, reasoning: true };
	return caps;
}

function applyImageTransportResolution(caps: CapabilityFlags, runtimeId: string): CapabilityFlags {
	return acceptsImageInput({ runtimeId, vision: caps.vision }) ? caps : { ...caps, vision: false };
}

/**
 * Resolve the effective capability set for one target/model pair.
 *
 * TargetStatus stores a merged target-level view in `capabilities`, which
 * is adequate for health/readiness, but the model picker and thinking controls
 * need the selected row's own profile hit. When model-keyed
 * `probeCapabilities` are present for this same wire model, rebuild the stack as:
 *
 *   runtime defaults + profile(model) + live probe + target override
 *
 * ranked by `mergeCapabilities`: a live yes or no decides tools, vision and
 * reasoning, and an operator value only fills what the server left silent.
 *
 * When older test doubles do not provide `probeCapabilities`, fall back to the
 * pre-merged `status.capabilities` for the target-default model.
 *
 * `options.detectedReasoning` lets callers feed in a per-model reasoning probe
 * result so /thinking and the model picker reflect what the loaded model can
 * actually do, without baking the detection into the runtime defaults.
 */
type ProbeCapabilityStatus = Pick<
	TargetStatus,
	"target" | "probeCapabilities" | "probeModelCapabilities" | "probeModelId"
>;

export function probeCapabilitiesForModel(
	status: ProbeCapabilityStatus,
	wireModelId: string | null | undefined,
): Partial<CapabilityFlags> | null {
	const modelId = normalizedModelId(wireModelId) ?? normalizedModelId(status.target.defaultModel);
	if (!modelId) return null;
	const exact = status.probeModelCapabilities?.[modelId];
	if (exact) return exact;
	const probeModelId = normalizedModelId(status.probeModelId);
	if (probeModelId !== null) return probeModelId === modelId ? (status.probeCapabilities ?? null) : null;
	const defaultModelId = normalizedModelId(status.target.defaultModel);
	return defaultModelId !== null && defaultModelId === modelId ? (status.probeCapabilities ?? null) : null;
}

export function resolveModelCapabilities(
	status: Pick<
		TargetStatus,
		"target" | "runtime" | "capabilities" | "probeCapabilities" | "probeModelCapabilities" | "probeModelId"
	>,
	wireModelId: string | null | undefined,
	knowledgeBase: KnowledgeBase | null,
	options?: ResolveModelCapabilitiesOptions,
): CapabilityFlags {
	const detectedReasoning = options?.detectedReasoning ?? null;
	const modelId = normalizedModelId(wireModelId) ?? normalizedModelId(status.target.defaultModel);
	const runtimeId = status.runtime?.id ?? status.target.runtime;
	const kbHit = modelId ? (knowledgeBase?.lookup(modelId, runtimeId) ?? null) : null;
	const override = status.target.capabilities ?? null;
	const probe = modelId ? probeCapabilitiesForModel(status, modelId) : null;
	// The server or the operator already answered when either carries a reasoning value.
	const answered = probe?.reasoning !== undefined || override?.reasoning !== undefined;

	if (!status.runtime) {
		return applyImageTransportResolution(
			applyReasoningResolution(status.capabilities, kbHit, detectedReasoning, answered),
			status.target.runtime,
		);
	}
	const baseCapabilities = capabilitiesFromCatalogModel(
		status.runtime.defaultCapabilities ?? EMPTY_CAPABILITIES,
		modelId ? getCatalogModelForRuntime(status.runtime.id, modelId) : undefined,
	);
	const hasModernProbeFields = status.probeCapabilities !== undefined || status.probeModelCapabilities !== undefined;
	if (!hasModernProbeFields) {
		if (!modelId || modelId === normalizedModelId(status.target.defaultModel)) {
			return applyImageTransportResolution(
				applyReasoningResolution(status.capabilities, kbHit, detectedReasoning, answered),
				status.runtime.id,
			);
		}
		const merged = mergeCapabilities(baseCapabilities, hintCapabilities(kbHit?.entry), null, override);
		return applyImageTransportResolution(
			applyReasoningResolution(
				withholdUnreportedServingWindow(status.runtime, merged, null, override).capabilities,
				kbHit,
				detectedReasoning,
				answered,
			),
			status.runtime.id,
		);
	}
	const merged = mergeCapabilities(baseCapabilities, hintCapabilities(kbHit?.entry), probe, override);
	return applyImageTransportResolution(
		applyReasoningResolution(
			withholdUnreportedServingWindow(status.runtime, merged, probe, override).capabilities,
			kbHit,
			detectedReasoning,
			answered,
		),
		status.runtime.id,
	);
}
