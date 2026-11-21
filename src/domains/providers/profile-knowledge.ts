import { ModelCatalogOverlays, resolveModelCatalogOverlayRoots, substringCatalogLookup } from "./catalog-overlays.js";
import {
	loadModelProfiles,
	loadPackagedModelProfiles,
	type ModelProfile,
	type ModelProfiles,
} from "./model-profiles.js";
import type { KnowledgeBase, KnowledgeBaseEntry, KnowledgeBaseHit, KnowledgeBaseRoot } from "./types/knowledge-base.js";

/**
 * The model catalog every resolver reads, in two tiers.
 *
 * Profiles (`models/profiles.yaml` with the operator's `model-profiles.yaml` layered on) answer what the
 * model is: windows, output cap, capability flags, thinking mechanism and levels, sampling.
 *
 * The fallback tier matches by substring and supplies a sampler and a family for parser selection: the
 * packaged profiles in file order, then the operator's `model-catalog.d` overlays. It never decides a
 * profile-owned field: its capability flags, window and output numbers and thinking block are dropped even
 * for a model no profile matches. A fallback entry whose family is the matched profile's id lends that
 * profile its sampler when the profile has none.
 */
export class ProfileKnowledgeBase implements KnowledgeBase {
	private current: ModelProfiles | null = null;
	private packaged: readonly KnowledgeBaseEntry[] = [];
	private fallback: readonly KnowledgeBaseEntry[] = [];

	constructor(
		private readonly loadProfiles: () => { profiles: ModelProfiles | null; packaged: readonly ModelProfile[] },
		private readonly overlays: ModelCatalogOverlays | null,
	) {
		this.loadTiers();
	}

	profiles(): ModelProfiles | null {
		return this.current;
	}

	/**
	 * Picks up an edited user profile file or catalog overlay without restarting. A bad overlay root throws; a
	 * malformed overlay file is skipped alone (`clio-coder doctor` names it).
	 */
	reload(): void {
		try {
			this.loadTiers();
			this.overlays?.reload();
		} finally {
			this.fallback = [...this.packaged, ...(this.overlays?.entries() ?? [])];
		}
	}

	entries(): ReadonlyArray<KnowledgeBaseEntry> {
		return (this.current?.entries() ?? []).map((profile) => entryFromProfile(profile, null));
	}

	/** The raw fallback-tier hit, before profile-owned fields are dropped. */
	fallbackLookup(modelId: string): KnowledgeBaseHit | null {
		return substringCatalogLookup(this.fallback, modelId);
	}

	lookup(modelId: string, runtimeId?: string): KnowledgeBaseHit | null {
		const old = this.fallbackLookup(modelId);
		const hit = this.current?.lookup(modelId, runtimeId) ?? null;
		if (hit) {
			return {
				matchKind: hit.kind === "exact" ? "alias" : "family",
				entry: entryFromProfile(hit.profile, old?.entry.family === hit.profile.id ? old.entry : null),
			};
		}
		return old ? { matchKind: old.matchKind, entry: withoutSwitchedFields(old.entry) } : null;
	}

	private loadTiers(): void {
		const loaded = this.loadProfiles();
		this.current = loaded.profiles;
		this.packaged = loaded.packaged.map(fallbackEntryFromProfile);
		this.fallback = [...this.packaged, ...(this.overlays?.entries() ?? [])];
	}
}

export interface ProfileKnowledgeBaseOptions {
	/** Reports a profile file or overlay that failed to load; the failure is never fatal. */
	onError?: (message: string) => void;
	/** `model-catalog.d` roots, lowest precedence first; defaults to the operator's config, project and env dirs. */
	overlayRoots?: ReadonlyArray<string | KnowledgeBaseRoot>;
	packagedPath?: string;
	userPath?: string;
}

/**
 * The packaged profiles with the user's override layered on, plus the fallback tier. A profile file that
 * fails to load leaves every switched field to the live server, the operator's limits and the Pi catalog,
 * and an overlay file that fails to load is skipped; both are reported and neither is fatal.
 */
export function createProfileKnowledgeBase(options: ProfileKnowledgeBaseOptions = {}): ProfileKnowledgeBase {
	const onError = options.onError ?? (() => undefined);
	let overlays: ModelCatalogOverlays | null = null;
	try {
		overlays = new ModelCatalogOverlays(options.overlayRoots ?? resolveModelCatalogOverlayRoots());
		for (const problem of overlays.problems()) onError(`model catalog overlay skipped: ${problem}`);
	} catch (err) {
		onError(`model catalog overlays disabled: ${err instanceof Error ? err.message : String(err)}`);
	}
	return new ProfileKnowledgeBase(() => {
		let packaged: ModelProfile[] = [];
		try {
			packaged = loadPackagedModelProfiles(options.packagedPath);
			const profiles = loadModelProfiles({
				packaged,
				onWarning: onError,
				...(options.userPath !== undefined ? { userPath: options.userPath } : {}),
			});
			return { profiles, packaged };
		} catch (err) {
			onError(`model profiles disabled: ${err instanceof Error ? err.message : String(err)}`);
			return { profiles: null, packaged };
		}
	}, overlays);
}

/** Sampling and serving notes a packaged profile contributes to the substring fallback tier. */
const FALLBACK_QUIRKS = ["sampling", "outputTokens", "runtimePreference"] as const;

function fallbackEntryFromProfile(profile: ModelProfile): KnowledgeBaseEntry {
	const quirks: Record<string, unknown> = {};
	for (const key of FALLBACK_QUIRKS) {
		const value = profile.recommendations?.[key];
		if (value !== undefined) quirks[key] = value;
	}
	return {
		family: profile.id,
		matchPatterns: [...(profile.match.exactIds ?? []), ...(profile.match.familyPrefixes ?? [])],
		capabilities: {},
		...(Object.keys(quirks).length > 0 ? { quirks } : {}),
	};
}

function entryFromProfile(profile: ModelProfile, old: KnowledgeBaseEntry | null): KnowledgeBaseEntry {
	const capabilities: KnowledgeBaseEntry["capabilities"] = { ...profile.claims.capabilities };
	const thinking = profile.behavior?.thinking;
	// A profile that names a mechanism and leaves the reasoning flag out still declares reasoning.
	if (capabilities.reasoning === undefined && isRecord(thinking) && typeof thinking.mechanism === "string") {
		capabilities.reasoning = thinking.mechanism !== "none";
	}
	const quirks: Record<string, unknown> = {};
	// A user profile with no sampler keeps the one its `model-catalog.d` family declares.
	const sampling = profile.recommendations?.sampling ?? old?.quirks?.sampling;
	if (sampling !== undefined) quirks.sampling = sampling;
	if (thinking !== undefined) quirks.thinking = thinking;
	// Replay field for reasoning recovered from raw Harmony markers (#435).
	const harmony = profile.behavior?.harmony;
	if (harmony !== undefined) quirks.harmony = harmony;
	const outputTokens = profile.recommendations?.outputTokens;
	if (typeof outputTokens === "number") quirks.outputTokens = outputTokens;
	return {
		family: profile.id,
		matchPatterns: [...(profile.match.exactIds ?? []), ...(profile.match.familyPrefixes ?? [])],
		capabilities,
		...(profile.claims.modelMaxContext !== undefined ? { modelMaxContext: profile.claims.modelMaxContext } : {}),
		...(profile.claims.modelMaxOutput !== undefined ? { modelMaxOutput: profile.claims.modelMaxOutput } : {}),
		...(Object.keys(quirks).length > 0 ? { quirks } : {}),
	};
}

function withoutSwitchedFields(entry: KnowledgeBaseEntry): KnowledgeBaseEntry {
	const { quirks: fallbackQuirks, ...rest } = entry;
	const quirks = { ...fallbackQuirks };
	delete quirks.thinking;
	return { ...rest, capabilities: {}, ...(Object.keys(quirks).length > 0 ? { quirks } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
