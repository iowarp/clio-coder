import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modelBootstrapGenerate } from "../../src/cli/bootstrap-generate.js";
import { UnsupportedResponseSchemaError } from "../../src/core/response-schema.js";
import type { BootstrapGenerateInput, BootstrapGenerationTelemetry } from "../../src/domains/context/bootstrap.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";

for (const schemaFallback of [false, true]) {
	test(`bootstrap treats serialized handbook text as evidence with ${schemaFallback ? "parser fallback" : "native schema"}`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-bootstrap-scope-"));
		const output = {
			projectName: "Harbor Batches",
			identity: "A sensor upload project.",
			conventions: [],
			invariants: [],
			sections: [{ title: "Architecture", body: "- `src/batches.js` groups uploads." }],
		};
		const requests: DispatchRequest[] = [];
		const generations: BootstrapGenerationTelemetry[] = [];
		const fallbacks: string[] = [];
		const dispatch = {
			dispatch: async (request: DispatchRequest) => {
				requests.push(request);
				// Exercise the production admission scope resolver, without a worker
				// or provider. The JSON-escaped newline was the real pre-model failure.
				match(request.task, /Batches\\n\\nBaseline/u);
				throws(
					() =>
						resolveDispatchPathScope({
							agentId: request.agentId,
							executionRole: request.executionRole,
							task: request.task,
							cwd,
						}),
					/legacy_scope_path_malformed/u,
				);
				const scope = resolveDispatchPathScope(request);
				strictEqual(scope.source, "declared");
				// The canonical intent normalizer represents repository-wide scope
				// as an empty list; the existing researcher recipe stays read-only.
				deepStrictEqual(scope.workingContextPaths, []);
				deepStrictEqual(scope.writeBoundaries, []);
				strictEqual(request.executionRole, "researcher");
				strictEqual(request.noSkills, true);
				if (schemaFallback && request.responseSchema) {
					throw new UnsupportedResponseSchemaError("fixture does not support response schemas");
				}
				return {
					runId: "bootstrap-scope-fixture",
					events: (async function* () {
						yield { type: "text_delta", text: JSON.stringify(output) };
					})(),
					finalPromise: Promise.resolve({
						runId: "bootstrap-scope-fixture",
						exitCode: 0,
						tokenCount: 0,
						toolCalls: 0,
						toolStats: [],
					}),
				};
			},
			abort: () => {},
		} as unknown as DispatchContract;
		const input: BootstrapGenerateInput = {
			cwd,
			expectedProjectName: "Harbor Batches",
			projectType: "javascript",
			existingClioMdText: "# Harbor Batches\n\nBaseline: preserve authored instructions.",
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
			const actual = await modelBootstrapGenerate({
				dispatch,
				onFallback: (error) => fallbacks.push(error.message),
			})(input);
			deepStrictEqual(fallbacks, []);
			deepStrictEqual(actual, output);
			strictEqual(requests.length, schemaFallback ? 2 : 1);
			strictEqual(generations.at(-1)?.mode, "model");
			strictEqual(generations.at(-1)?.parserOutcome, "parsed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}
