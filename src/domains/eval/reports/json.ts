import type { EvalArtifactV4 } from "../schema/artifact.js";

export function renderEvalJsonReportV4(artifact: EvalArtifactV4): string {
	return `${JSON.stringify(artifact, null, 2)}\n`;
}
