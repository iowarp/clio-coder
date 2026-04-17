/**
 * Deterministic routing: maps a RoutingRequest to a specific provider + model
 * drawn from the catalog. Pure logic; no I/O, no settings, no credentials.
 */

import { type ModelSpec, PROVIDER_CATALOG, type ProviderId } from "./catalog.js";

export interface RoutingRequest {
	requestedModelId?: string;
	requestedProviderId?: ProviderId;
	requiredCapabilities?: ReadonlyArray<"thinking" | "vision" | "tools">;
}

export interface RoutingMatch {
	providerId: ProviderId;
	modelId: string;
	confidence: "exact" | "fallback";
	reason: string;
}

function capabilityOk(model: ModelSpec, caps: ReadonlyArray<string>): boolean {
	for (const cap of caps) {
		if (cap === "thinking" && !model.thinkingCapable) return false;
	}
	return true;
}

function describe(req: RoutingRequest): string {
	const parts: string[] = [];
	if (req.requestedProviderId) parts.push(`provider=${req.requestedProviderId}`);
	if (req.requestedModelId) parts.push(`model=${req.requestedModelId}`);
	if (req.requiredCapabilities?.length) parts.push(`caps=${req.requiredCapabilities.join("+")}`);
	return parts.length > 0 ? parts.join(" ") : "<empty>";
}

export function match(req: RoutingRequest): RoutingMatch {
	const caps = req.requiredCapabilities ?? [];

	if (req.requestedProviderId && req.requestedModelId) {
		const provider = PROVIDER_CATALOG.find((p) => p.id === req.requestedProviderId);
		const model = provider?.models.find((m) => m.id === req.requestedModelId);
		if (provider && model && capabilityOk(model, caps)) {
			return {
				providerId: provider.id,
				modelId: model.id,
				confidence: "exact",
				reason: "explicit provider+model resolved in catalog",
			};
		}
		throw new Error(`no provider match for ${describe(req)}`);
	}

	if (req.requestedModelId) {
		for (const provider of PROVIDER_CATALOG) {
			const model = provider.models.find((m) => m.id === req.requestedModelId);
			if (model && capabilityOk(model, caps)) {
				return {
					providerId: provider.id,
					modelId: model.id,
					confidence: "exact",
					reason: `model resolved to first catalog provider (${provider.id})`,
				};
			}
		}
		throw new Error(`no provider match for ${describe(req)}`);
	}

	if (req.requestedProviderId) {
		const provider = PROVIDER_CATALOG.find((p) => p.id === req.requestedProviderId);
		const model = provider?.models.find((m) => capabilityOk(m, caps));
		if (provider && model) {
			return {
				providerId: provider.id,
				modelId: model.id,
				confidence: "fallback",
				reason: `first compatible model from ${provider.id}`,
			};
		}
		throw new Error(`no provider match for ${describe(req)}`);
	}

	// Only capabilities (or nothing) provided: scan all providers in catalog
	// order and return the first model that satisfies the filter.
	for (const provider of PROVIDER_CATALOG) {
		const model = provider.models.find((m) => capabilityOk(m, caps));
		if (model) {
			return {
				providerId: provider.id,
				modelId: model.id,
				confidence: "fallback",
				reason:
					caps.length > 0
						? `first model satisfying ${caps.join("+")} (${provider.id}:${model.id})`
						: `first catalog model (${provider.id}:${model.id})`,
			};
		}
	}

	throw new Error(`no provider match for ${describe(req)}`);
}
