import type { EvalArtifactV3 } from "../schema/artifact.js";

export function withEvidenceArtifactPath(artifact: EvalArtifactV3, evidencePath: string): EvalArtifactV3 {
	return {
		...artifact,
		results: artifact.results.map((result) => ({
			...result,
			artifacts: { ...result.artifacts, evidence: evidencePath },
		})),
	};
}
