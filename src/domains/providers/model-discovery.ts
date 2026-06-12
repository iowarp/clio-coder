import type { EndpointStatus } from "./contract.js";
import { listKnownModelsForRuntime } from "./support.js";

export type ProviderModelSource = "configured" | "live" | "catalog" | "default";

export interface ProviderModelCandidate {
	id: string;
	source: ProviderModelSource;
	loadState?: string;
	loadStateDetail?: string;
}

function uniqueModels(ids: ReadonlyArray<string | undefined>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		const trimmed = id?.trim() ?? "";
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

export function modelLoadStateLabel(status: EndpointStatus, modelId: string): string {
	return status.discoveredModelStates?.[modelId]?.state ?? "-";
}

export function hasLiveModelCatalog(status: EndpointStatus): boolean {
	if (status.discoveredModelsSource === "probe" || status.discoveredModelsSource === "cache") return true;
	// Unit-test and plugin mocks from before `discoveredModelsSource` still use
	// `discoveredModels` to mean "this came from discovery".
	return status.discoveredModelsSource === undefined && status.discoveredModels.length > 0;
}

/**
 * Enumerate selectable wire model ids for a target. Before a live catalog is
 * known, Clio keeps useful configured/default/catalog hints. Once the target
 * has returned a live catalog, that catalog is authoritative so stale
 * configured model names do not keep resolving after a provider removes them.
 */
export function modelCandidatesForStatus(status: EndpointStatus): ProviderModelCandidate[] {
	const configured = uniqueModels(status.endpoint.wireModels ?? []);
	const discovered = uniqueModels(status.discoveredModels);
	const defaultModel = status.endpoint.defaultModel?.trim() ?? "";
	const out: ProviderModelCandidate[] = [];
	const seen = new Set<string>();
	const add = (id: string, source: ProviderModelSource): void => {
		const trimmed = id.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) return;
		seen.add(trimmed);
		const state = status.discoveredModelStates?.[trimmed];
		out.push({
			id: trimmed,
			source,
			...(state ? { loadState: state.state } : {}),
			...(state?.detail ? { loadStateDetail: state.detail } : {}),
		});
	};

	if (hasLiveModelCatalog(status)) {
		const liveSet = new Set(discovered);
		for (const id of configured) {
			if (liveSet.has(id)) add(id, "live");
		}
		if (defaultModel && liveSet.has(defaultModel)) add(defaultModel, "live");
		for (const id of discovered) add(id, "live");
		return out;
	}

	if (configured.length > 0) {
		for (const id of configured) add(id, "configured");
		if (defaultModel) add(defaultModel, "default");
		return out;
	}

	const knownModels = listKnownModelsForRuntime(status.runtime?.id ?? status.endpoint.runtime);
	if (knownModels.length > 0) {
		const knownSet = new Set(knownModels);
		for (const id of uniqueModels([defaultModel, ...knownModels])) {
			add(id, knownSet.has(id) ? "catalog" : "default");
		}
		return out;
	}

	if (defaultModel) add(defaultModel, "default");
	return out;
}

export function modelIdsForStatus(status: EndpointStatus): string[] {
	return modelCandidatesForStatus(status).map((candidate) => candidate.id);
}
