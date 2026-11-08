import type { ClioSettings } from "../../core/config.js";
import { resolveEffectivePricing } from "./catalog.js";
import type { ProvidersContract } from "./contract.js";
import { resolveModelReference } from "./resolver.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

export function resolveTarget(
	providers: ProvidersContract,
	targetId: string | null | undefined,
): TargetDescriptor | null {
	if (!targetId) return null;
	return providers.getTarget(targetId);
}

/**
 * The routes a `clio-coder run --max-cost-usd` run can reach whose cost is
 * unknown: the chat route, the compaction route, the default worker route,
 * every fleet profile (recipe pins in `fleet.agentProfiles` and coordinator
 * profile picks resolve to one), every roster member, and each configured
 * target at its default model, which a coordinator pin naming only a target
 * takes. Paid-request admission checks only known or estimated pricing, so
 * the cap cannot bound these; LiteLLM stays unknown until its target declares
 * `pricing`. A model a coordinator names one-off is not known at boot.
 */
export function unpricedRunRoutes(
	settings: Readonly<ClioSettings>,
	providers: ProvidersContract | undefined,
): string[] {
	if (!providers) return [];
	const routes: Array<{ target: string | null | undefined; model?: string | null | undefined }> = [
		settings.chat,
		settings.fleet.default,
		...Object.values(settings.fleet.profiles),
		...Object.values(settings.fleet.rosters).flatMap((roster) => roster.members),
		...settings.targets.map((target) => ({ target: target.id })),
	];
	const compaction = settings.context.compaction.model;
	if (compaction) {
		try {
			const selected = resolveModelReference(compaction, providers, { use: "chat" });
			if (selected.ref && !selected.warning) routes.push(selected.ref);
		} catch {
			// An invalid compaction pattern fails compaction itself with its own message.
		}
	}
	const unpriced = new Set<string>();
	for (const route of routes) {
		const target = resolveTarget(providers, route.target);
		const runtime = target ? providers.getRuntime(target.runtime) : null;
		const model = route.model ?? target?.defaultModel;
		if (!target || !runtime || !model) continue;
		if (resolveEffectivePricing(target, runtime, model).pricedBy === "none") unpriced.add(`${target.id}/${model}`);
	}
	return [...unpriced];
}
