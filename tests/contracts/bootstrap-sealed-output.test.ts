import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modelBootstrapGenerate } from "../../src/cli/bootstrap-generate.js";
import type { BootstrapGenerateInput, BootstrapGenerationTelemetry } from "../../src/domains/context/bootstrap.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";

// The context-handbook result contract has the worker submit its handbook
// through a tool call, so the transcript can hold no assistant text, or only a
// sentence of narration, while the receipt carries the sealed JSON. Reading the
// transcript alone made every frontier-model `context init` fall back to the
// heuristic handbook.
const output = {
	projectName: "Harbor Batches",
	identity: "A sensor upload project.",
	conventions: [],
	invariants: ["Never write `src/batches.js` output outside `out/`."],
	sections: [{ title: "Change recipes", body: "- `src/batches.js` changes need `tests/batches.test.js`." }],
};

for (const narration of ["", "I have enough. Submitting the handbook."]) {
	test(`bootstrap reads the sealed receipt output when the transcript holds ${narration ? "only narration" : "no text"}`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-coder-bootstrap-sealed-"));
		const generations: BootstrapGenerationTelemetry[] = [];
		const fallbacks: string[] = [];
		const dispatch = {
			dispatch: async () => ({
				runId: "bootstrap-sealed-fixture",
				events: (async function* () {
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							content: [
								...(narration ? [{ type: "text", text: narration }] : []),
								{ type: "toolCall", id: "call-1", name: "clio_submit_result", arguments: output },
							],
						},
					};
				})(),
				finalPromise: Promise.resolve({
					runId: "bootstrap-sealed-fixture",
					exitCode: 0,
					tokenCount: 0,
					toolCalls: 1,
					toolStats: [],
					output: { state: "final", text: JSON.stringify(output) },
				}),
			}),
			abort: () => {},
		} as unknown as DispatchContract;
		const input: BootstrapGenerateInput = {
			cwd,
			expectedProjectName: "Harbor Batches",
			projectType: "javascript",
			siblingFiles: [],
			adoption: {
				cwd,
				homeDir: cwd,
				includeGlobal: false,
				sources: [],
				rejected: [],
				importedRules: [],
				conflicts: [],
				sourceHash: "fixture",
				sourceSnapshots: [],
			},
			codewiki: { version: 5, language: "javascript", files: [], symbols: [], edges: [] },
			reportGeneration: (generation) => generations.push(generation),
		};
		try {
			const actual = await modelBootstrapGenerate({ dispatch, onFallback: (error) => fallbacks.push(error.message) })(
				input,
			);
			deepStrictEqual(fallbacks, []);
			deepStrictEqual(actual, output);
			strictEqual(generations.at(-1)?.parserOutcome, "parsed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}
