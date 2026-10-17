import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { BASH_DEFAULT_RESULT_DISPOSITION, bashTool } from "../../src/tools/bash.js";
import { builtin } from "../../src/tools/builtin-tool-catalog.js";
import type { ToolResultDispositionMetadata } from "../../src/tools/result-disposition.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("complete results omit retrieval hints across every builtin summary policy, while omitted output stays retrievable", async () => {
	const env = await isolateClioEnv("tool-result-retrieval-hints-");
	try {
		const specs = Object.values(ToolNames)
			.map((name) => builtin({ ...bashTool, name }, { path: "src/tools/builtin-tool-catalog.ts", scope: "core" }))
			.filter((spec) => spec.metadata?.resultSizePolicy.kind === "summary");
		ok(specs.some((spec) => spec.name === ToolNames.Bash));
		ok(specs.some((spec) => spec.name === ToolNames.Dispatch));
		for (const spec of specs) {
			for (const result of [
				{ kind: "ok", output: "complete output" },
				{ kind: "error", message: "complete diagnostic" },
			] as const) {
				const shaped = shapeToolResult(spec, result);
				const metadata = shaped.details?.resultDisposition as ToolResultDispositionMetadata;
				strictEqual(metadata?.contextTruncated ?? false, false, spec.name);
				strictEqual(metadata?.retrieval, undefined, spec.name);
				doesNotMatch(shaped.modelContext ?? "", /retrieve=|followUp=|omitted output/u, spec.name);
			}
		}
		const bash = specs.find((spec) => spec.name === ToolNames.Bash);
		ok(bash);
		for (const mode of ["bounded", "summary", "full"] as const) {
			const result = shapeToolResult(bash, { kind: "ok", output: "complete diff" }, undefined, {
				...BASH_DEFAULT_RESULT_DISPOSITION,
				context: { mode, maxBytes: 16_384 },
			});
			doesNotMatch(result.modelContext ?? "", /retrieve=|followUp=|omitted output/u);
		}
		for (const output of ["line of output\n".repeat(2000), "x".repeat(450)]) {
			const result = shapeToolResult(
				bash,
				{ kind: "ok", output },
				{ sessionId: "omitted-output" },
				{
					...BASH_DEFAULT_RESULT_DISPOSITION,
					context: { mode: "bounded", maxBytes: 512 },
				},
			);
			const metadata = result.details?.resultDisposition as ToolResultDispositionMetadata;
			strictEqual(metadata.contextTruncated, true);
			ok(metadata.retrieval);
			match(result.modelContext ?? "", /truncated=true/u);
			match(result.modelContext ?? "", /retrieve=/u);
		}
	} finally {
		env.restore();
	}
});
