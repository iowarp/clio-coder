import { loadModelProfiles, type ModelProfile, type ModelProfiles } from "./model-profiles.js";
import type { KnowledgeBase, KnowledgeBaseEntry, KnowledgeBaseHit } from "./types/knowledge-base.js";

/**
 * Refactor step 4: `models/profiles.yaml` answers what the model is (windows, output cap,
 * capability flags, thinking mechanism and levels) through the `KnowledgeBase` shape every
 * resolver already consumes. Profiles also supply sampling recommendations, including user
 * overrides. The legacy catalog supplies a fallback sampler and family for parser selection, so it never
 * decides a switched field: its capability flags, window and output numbers, and thinking
 * block are dropped even for a model no profile matches. Step 5 deletes the legacy side.
 */
export class ProfileKnowledgeBase implements KnowledgeBase {
	private current: ModelProfiles | null;

	constructor(
		private readonly loadProfiles: () => ModelProfiles | null,
		private readonly legacy: KnowledgeBase,
	) {
		this.current = loadProfiles();
	}

	profiles(): ModelProfiles | null {
		return this.current;
	}

	legacyCatalog(): KnowledgeBase {
		return this.legacy;
	}

	/** Picks up an edited user profile file or catalog overlay without restarting. */
	reload(): void {
		this.current = this.loadProfiles();
		const reload = (this.legacy as { reload?: unknown }).reload;
		if (typeof reload === "function") reload.call(this.legacy);
	}

	entries(): ReadonlyArray<KnowledgeBaseEntry> {
		return (this.current?.entries() ?? []).map((profile) => entryFromProfile(profile, null));
	}

	lookup(modelId: string, runtimeId?: string): KnowledgeBaseHit | null {
		const old = this.legacy.lookup(modelId, runtimeId);
		const hit = this.current?.lookup(modelId, runtimeId) ?? null;
		if (hit) {
			return {
				matchKind: hit.kind === "exact" ? "alias" : "family",
				entry: entryFromProfile(hit.profile, old?.entry.family === hit.profile.id ? old.entry : null),
			};
		}
		return old ? { matchKind: old.matchKind, entry: withoutSwitchedFields(old.entry) } : null;
	}
}

/**
 * The profile file that ships with the package, with the user's override layered on it. A
 * file that fails to load leaves every switched field to the live server, the operator's
 * limits and the Pi catalog, so the failure is reported and never fatal.
 */
export function createProfileKnowledgeBase(
	legacy: KnowledgeBase,
	onError: (message: string) => void = () => undefined,
): ProfileKnowledgeBase {
	return new ProfileKnowledgeBase(() => {
		try {
			return loadModelProfiles({ onWarning: onError });
		} catch (err) {
			onError(`model profiles disabled: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}, legacy);
}

function entryFromProfile(profile: ModelProfile, old: KnowledgeBaseEntry | null): KnowledgeBaseEntry {
	const capabilities: KnowledgeBaseEntry["capabilities"] = { ...profile.claims.capabilities };
	const thinking = profile.behavior?.thinking;
	// A profile that names a mechanism and leaves the reasoning flag out still declares reasoning.
	if (capabilities.reasoning === undefined && isRecord(thinking) && typeof thinking.mechanism === "string") {
		capabilities.reasoning = thinking.mechanism !== "none";
	}
	const quirks: Record<string, unknown> = {};
	// User profiles must keep their sampler when the packaged legacy family is retired.
	const sampling = profile.recommendations?.sampling ?? old?.quirks?.sampling;
	if (sampling !== undefined) quirks.sampling = sampling;
	if (thinking !== undefined) quirks.thinking = thinking;
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
	const { quirks: legacyQuirks, ...rest } = entry;
	const quirks = { ...legacyQuirks };
	delete quirks.thinking;
	return { ...rest, capabilities: {}, ...(Object.keys(quirks).length > 0 ? { quirks } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
