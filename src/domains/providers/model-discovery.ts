import type { TargetStatus } from "./contract.js";
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

export function modelLoadStateLabel(status: TargetStatus, modelId: string): string {
	return status.discoveredModelStates?.[modelId]?.state ?? "-";
}

export function hasLiveModelCatalog(status: TargetStatus): boolean {
	if (status.discoveredModelsSource === "probe" || status.discoveredModelsSource === "cache") return true;
	// Unit-test and plugin mocks from before `discoveredModelsSource` still use
	// `discoveredModels` to mean "this came from discovery".
	return status.discoveredModelsSource === undefined && status.discoveredModels.length > 0;
}

/**
 * Enumerate selectable wire model ids for a target. Before a live catalog is
 * known, Clio keeps useful configured/default/catalog hints. Once the target
 * returns a live catalog, that catalog is authoritative: configured and default
 * model ids that the provider no longer returns stop resolving.
 */
export function modelCandidatesForStatus(status: TargetStatus): ProviderModelCandidate[] {
	const configured = uniqueModels(status.target.wireModels ?? []);
	const discovered = uniqueModels(status.discoveredModels);
	const defaultModel = status.target.defaultModel?.trim() ?? "";
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
		for (const id of discovered) add(id, "live");
		return out;
	}

	if (configured.length > 0) {
		for (const id of configured) add(id, "configured");
		if (defaultModel) add(defaultModel, "default");
		return out;
	}

	const knownModels = listKnownModelsForRuntime(status.runtime?.id ?? status.target.runtime);
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

export function modelIdsForStatus(status: TargetStatus): string[] {
	return modelCandidatesForStatus(status).map((candidate) => candidate.id);
}

export function canonicalizeWireModelId(status: TargetStatus, requested: string): string {
	const trimmedRequested = requested.trim();
	if (trimmedRequested.length === 0) return requested;
	// Canonicalize against the authoritative wire ids: the live catalog when one
	// exists, otherwise the configured wire models.
	const candidates = uniqueModels(
		hasLiveModelCatalog(status) ? status.discoveredModels : (status.target.wireModels ?? []),
	);
	if (candidates.includes(trimmedRequested)) return trimmedRequested;

	const separators = ["-", ":", ".", "/"];
	const matches = candidates.filter((candidate) => {
		if (candidate.toLowerCase() === trimmedRequested.toLowerCase()) return true;
		return separators.some((separator) => candidate.startsWith(`${trimmedRequested}${separator}`));
	});
	return matches.length === 1 ? (matches[0] ?? requested) : requested;
}
