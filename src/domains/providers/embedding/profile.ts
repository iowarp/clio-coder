import { createHash } from "node:crypto";
import type { EmbeddingProfile } from "./types.js";

export function embeddingGemma2Q8Profile(options: {
	model: string;
	assetIdentity: string;
	projectorIdentity?: string;
	canaryFingerprint?: string;
}): EmbeddingProfile {
	return {
		id: "embeddinggemma-2-q8-768",
		model: options.model,
		assetIdentity: options.assetIdentity,
		projectorIdentity: options.projectorIdentity ?? null,
		quantization: "Q8_0",
		dimensions: 768,
		pooling: "mean",
		normalization: "l2",
		queryPrefix: "task: search result | query: ",
		documentPrefix: "title: none | text: ",
		preprocessingVersion: "clio-embedding-v1",
		canaryFingerprint: options.canaryFingerprint ?? null,
	};
}

export function embeddingProfileIdentity(profile: EmbeddingProfile): string {
	const canonical = Object.fromEntries(
		Object.keys(profile)
			.sort()
			.map((key) => [key, profile[key as keyof EmbeddingProfile]]),
	);
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function embeddingCanaryFingerprint(vectors: readonly (readonly number[])[]): string {
	return createHash("sha256")
		.update(JSON.stringify(vectors.map((vector) => vector.map((value) => Number(value.toFixed(6))))))
		.digest("hex");
}
