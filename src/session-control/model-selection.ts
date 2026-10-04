import { rememberRecentModel } from "../core/recent-models.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/eligibility.js";
import { resolveModelRuntimeCapabilitiesForProviders } from "../domains/providers/model-runtime-capabilities.js";
import type { ThinkingLevel } from "../domains/providers/types/capability-flags.js";

export function clampThinkingLevel(
	providers: ProvidersContract | undefined,
	target: string | null,
	model: string | null,
	level: ThinkingLevel,
): ThinkingLevel {
	if (providers === undefined) return level;
	return resolveModelRuntimeCapabilitiesForProviders(providers, target, model, level)?.thinking.effectiveLevel ?? "off";
}

export function selectModel(
	providers: ProvidersContract,
	selection: { target: string; model: string; thinkingLevel: ThinkingLevel },
	apply: (selection: { target: string; model: string; thinkingLevel: ThinkingLevel }) => void,
	recentLimit?: number,
): { target: string; model: string; thinkingLevel: ThinkingLevel } {
	const descriptor = providers.getTarget(selection.target);
	if (!descriptor) throw new Error(`unknown orchestrator target '${selection.target}'`);
	const runtime = providers.getRuntime(descriptor.runtime);
	if (!runtime)
		throw new Error(
			`cannot use target '${selection.target}' as orchestrator target because runtime '${descriptor.runtime}' is not registered`,
		);
	if (!isOrchestratorEligibleRuntime(runtime))
		throw new Error(
			`cannot use target '${selection.target}' as orchestrator target because runtime '${runtime.id}' is not an HTTP/native runtime`,
		);
	const selected = {
		...selection,
		thinkingLevel: clampThinkingLevel(providers, selection.target, selection.model, selection.thinkingLevel),
	};
	apply(selected);
	if (recentLimit !== undefined) rememberRecentModel(`${selected.target}/${selected.model}`, recentLimit);
	return selected;
}
