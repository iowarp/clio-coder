import type { EvalArtifactV2 } from "../schema/artifact-v2.js";

export function withEvidenceArtifactPath(artifact: EvalArtifactV2, evidencePath: string): EvalArtifactV2 {
	return {
		...artifact,
		results: artifact.results.map((result) => ({
			...result,
			artifacts: { ...result.artifacts, evidence: evidencePath },
		})),
	};
}
