import type { EvalArtifactV2 } from "../schema/artifact.js";

export function renderEvalJsonReportV2(artifact: EvalArtifactV2): string {
	return `${JSON.stringify(artifact, null, 2)}\n`;
}
