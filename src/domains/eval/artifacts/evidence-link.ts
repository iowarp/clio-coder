import type { EvalArtifactV4 } from "../schema/artifact.js";

export function withEvidenceArtifactPath(artifact: EvalArtifactV4, evidencePath: string): EvalArtifactV4 {
	return {
		...artifact,
		results: artifact.results.map((result) => ({
			...result,
			artifacts: { ...result.artifacts, evidence: evidencePath },
		})),
	};
}
