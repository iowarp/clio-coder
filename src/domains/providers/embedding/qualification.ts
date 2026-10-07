import { embeddingCanaryFingerprint } from "./profile.js";
import type { EmbeddingProfile, EmbeddingService } from "./types.js";
import { EmbeddingError } from "./types.js";

/** Explicit inference, never discovery/startup: callers retain the resulting recipe with their index. */
export async function qualifyEmbeddingProfile(
	service: EmbeddingService,
	profile: EmbeddingProfile,
	signal?: AbortSignal,
): Promise<EmbeddingProfile> {
	const result = await service.embed({
		inputs: [
			{ kind: "text", text: "Clio embedding canary v1: delayed oscillation after checkpoint." },
			{ kind: "text", text: "Clio embedding canary v1: unrelated coastal weather observation." },
		],
		task: "query",
		profile,
		...(signal ? { signal } : {}),
	});
	const fingerprint = embeddingCanaryFingerprint(result.vectors);
	if (profile.canaryFingerprint !== null && profile.canaryFingerprint !== fingerprint)
		throw new EmbeddingError(
			"profile-mismatch",
			"Embedding canary differs from the pinned profile; re-embedding requires a separate generation",
		);
	return { ...profile, canaryFingerprint: fingerprint };
}
