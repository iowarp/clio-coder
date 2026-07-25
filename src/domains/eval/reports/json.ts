import type { EvalArtifactV3 } from "../schema/artifact.js";

export function renderEvalJsonReportV3(artifact: EvalArtifactV3): string {
	return `${JSON.stringify(artifact, null, 2)}\n`;
}
