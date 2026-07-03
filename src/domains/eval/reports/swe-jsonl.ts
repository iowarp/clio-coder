import type { EvalArtifactV2 } from "../schema/artifact-v2.js";

export function renderEvalSweJsonlReportV2(artifact: EvalArtifactV2): string {
	return artifact.results
		.map((result) =>
			JSON.stringify({
				instance_id: result.taskId,
				model_name_or_path: artifact.matrix.model ?? artifact.matrix.target,
				model_patch: typeof result.artifacts.patch === "string" ? result.artifacts.patch : "",
				status: result.pass ? "pass" : "fail",
				pass: result.pass,
			}),
		)
		.join("\n")
		.concat(artifact.results.length === 0 ? "" : "\n");
}
