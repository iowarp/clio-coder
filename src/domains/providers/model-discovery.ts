import type { TargetStatus } from "./contract.js";
import { listKnownModelsForRuntime } from "./support.js";
import type { ContextWindowSlots } from "./types/context-window-slots.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

export type ProviderModelSource = "configured" | "live" | "cache" | "catalog" | "default";

export interface ProviderModelCandidate {
	id: string;
	label?: string;
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

/** Whether the model is serving, waiting to serve, or not on the server at all. */
export type ModelResidency = "resident" | "loading" | "absent" | "unknown";

type DiscoveryStatus = Pick<TargetStatus, "discoveredModelStates">;

/**
 * The window discovery says this model is loaded at, or null when discovery has
 * no such number. Ranked above every declared window: `max_context_length` is
 * what the weights allow, this is what the backend will actually serve, and a
 * run planned against the larger one overruns before compaction ever fires.
 */
export function loadedContextWindowForModel(
	status: DiscoveryStatus | null | undefined,
	modelId: string,
): number | null {
	const reported = status?.discoveredModelStates?.[modelId]?.contextLength;
	return typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : null;
}

/** How the server splits its KV budget for this model, when the probe saw it split. */
export function contextSlotsForModel(
	status: DiscoveryStatus | null | undefined,
	modelId: string,
): ContextWindowSlots | null {
	return status?.discoveredModelStates?.[modelId]?.contextSlots ?? null;
}

/**
 * Residency as one view, so the planner and the "not resident" notice cannot
 * disagree about the same model. A reported loaded window settles it whatever
 * the state field says: a server does not hold a window open for a model it has
 * not loaded.
 */
export function modelResidencyForStatus(status: DiscoveryStatus | null | undefined, modelId: string): ModelResidency {
	if (loadedContextWindowForModel(status, modelId) !== null) return "resident";
	switch (status?.discoveredModelStates?.[modelId]?.state) {
		case "loaded":
			return "resident";
		case "loading":
			return "loading";
		case "unloaded":
			return "absent";
		default:
			return "unknown";
	}
}

export function hasLiveModelCatalog(status: TargetStatus): boolean {
	return status.discoveredModelsSource === "probe";
}

/**
 * Whether the runtime can ask its provider which models exist right now. When
 * it can and the provider answers, that answer is the model list and the static
 * catalog is only the fallback for when no answer comes. A runtime that cannot
 * ask has only its catalog, and every surface labels it as one. Configure and
 * the providers domain both decide by this, so no surface lists a catalog where
 * another lists the live answer.
 */
export function runtimeListsModelsLive(
	runtime: Pick<RuntimeDescriptor, "kind" | "probe" | "probeModels" | "externalAgentLoop">,
): boolean {
	if (runtime.externalAgentLoop?.modelCatalog === "live-authoritative") return true;
	return runtime.kind === "http" && (typeof runtime.probe === "function" || typeof runtime.probeModels === "function");
}

export type UnverifiedModelListOrigin = "cache" | "catalog" | "configured";

/**
 * The words every surface puts beside a model list that is not the provider's
 * live answer: what the list is, and why the live answer is missing. `reason`
 * is the failed probe's diagnostic when there was one.
 */
export function unverifiedModelListNote(
	origin: UnverifiedModelListOrigin,
	input: { runtimeId: string; listsLive: boolean; reason?: string | null | undefined },
): string {
	const list = origin === "cache" ? "cached list" : origin === "catalog" ? "provider catalog" : "configured list";
	if (!input.listsLive) return `${list}; ${input.runtimeId} does not list its models live`;
	return input.reason ? `${list}, not verified live: ${input.reason}` : `${list}, not verified live`;
}

/** The note for the list `modelCandidatesForStatus` returns, or null when that list is the live answer. */
export function modelListNoteForStatus(status: TargetStatus): string | null {
	const candidates = modelCandidatesForStatus(status);
	if (candidates.length === 0 || candidates.some((candidate) => candidate.source === "live")) return null;
	const origin: UnverifiedModelListOrigin = candidates.some((candidate) => candidate.source === "cache")
		? "cache"
		: candidates.some((candidate) => candidate.source === "catalog")
			? "catalog"
			: "configured";
	return unverifiedModelListNote(origin, {
		runtimeId: status.runtime?.id ?? status.target.runtime,
		listsLive: status.runtime !== null && runtimeListsModelsLive(status.runtime),
		reason: status.health.lastError,
	});
}

/**
 * Enumerate selectable wire model ids for a target. Before a live catalog is
 * known, Clio keeps useful configured/default/catalog hints. Once the target
 * returns a live catalog, it supplies the current selectable candidates. Cached
 * catalogs remain useful hints alongside configured/default ids, never live proof.
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
		const state = hasLiveModelCatalog(status) ? status.discoveredModelStates?.[trimmed] : undefined;
		out.push({
			id: trimmed,
			...(status.discoveredModelLabels?.[trimmed] ? { label: status.discoveredModelLabels[trimmed] } : {}),
			source,
			...(state ? { loadState: state.state } : {}),
			...(state?.detail ? { loadStateDetail: state.detail } : {}),
		});
	};

	if (hasLiveModelCatalog(status) && discovered.length > 0) {
		for (const id of discovered) add(id, "live");
		return out;
	}

	// A cached catalog is still useful for selection, but it cannot exclude an
	// explicitly configured model or claim that an instance is currently loaded.
	if (status.discoveredModelsSource === "cache") {
		for (const id of configured) add(id, "configured");
		if (defaultModel) add(defaultModel, "default");
		for (const id of discovered) add(id, "cache");
		if (out.length > 0) return out;
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
	// Prefer live wire ids; otherwise retain configured ids and cached hints.
	const candidates = uniqueModels(
		hasLiveModelCatalog(status)
			? status.discoveredModels
			: [
					...(status.target.wireModels ?? []),
					status.target.defaultModel ?? "",
					...(status.discoveredModelsSource === "cache" ? status.discoveredModels : []),
				],
	);
	if (candidates.includes(trimmedRequested)) return trimmedRequested;

	const separators = ["-", ":", ".", "/"];
	const matches = candidates.filter((candidate) => {
		if (candidate.toLowerCase() === trimmedRequested.toLowerCase()) return true;
		return separators.some((separator) => candidate.startsWith(`${trimmedRequested}${separator}`));
	});
	return matches.length === 1 ? (matches[0] ?? requested) : requested;
}
