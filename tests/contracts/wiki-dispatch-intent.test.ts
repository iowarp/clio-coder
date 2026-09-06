import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import { asDirectoryPathBoundary } from "../../src/core/path-boundary.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { WikiGenerateInput } from "../../src/domains/context/wiki/generate.js";
import { readWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { classifyDispatchIntentCompatibility } from "../../src/domains/dispatch/intent-compatibility.js";
import { resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("admits production wiki planner and page scope without interpreting absolute prompt punctuation", async () => {
	const isolated = await isolateClioEnv("wiki-dispatch-intent-");
	const originalCwd = process.cwd();
	try {
		const cwd = join(isolated.dir, "repo");
		const outputDir = join(cwd, ".clio-coder", "wiki-staging-period.");
		mkdirSync(outputDir, { recursive: true });
		// The real worker runs in the dispatched repository; the safety
		// classifier uses that process cwd when classifying absolute writes.
		process.chdir(cwd);
		const page = {
			path: "api.md",
			title: "API",
			intent: "Explain API",
			sources: ["src/api.ts"],
			status: "pending" as const,
			attempts: 0,
		};
		const plan = { version: 1 as const, overview: "API fixture", pages: [page] };
		const input: WikiGenerateInput = {
			cwd,
			outputDir,
			mode: "init",
			resumed: false,
			plan,
			unclaimedAreas: [],
			codewiki: { version: 5, language: "typescript", files: [], symbols: [], edges: [] },
			generation: { requestedDepth: "simple", depth: "simple", sourceFiles: 1, sourceLines: 1, plan },
		};
		writeFileSync(join(outputDir, page.path), "# Seeded API\n");
		const requests: DispatchRequest[] = [];
		const dispatch = {
			abort() {},
			async dispatch(spec: DispatchRequest) {
				requests.push(spec);
				if (requests.length === 2) writeFileSync(join(outputDir, page.path), "# API\n");
				return {
					runId: `wiki-${requests.length}`,
					events: (async function* () {})(),
					finalPromise: Promise.resolve({ exitCode: 0 }),
				};
			},
		} as unknown as DispatchContract;
		const generate = modelWikiGenerate({ dispatch });
		await generate(input);
		assert.equal(requests.length, 2);
		for (const spec of requests) {
			const scope = resolveDispatchPathScope(spec);
			assert.equal(scope.source, "declared");
			const policy = createSafetyPolicyEngine({ cwd, writeRoots: scope.writeBoundaries });
			for (const target of [join(outputDir, "api.md"), join(outputDir, "nested", "api.md")]) {
				assert.equal(policy.evaluate({ tool: ToolNames.Write, args: { path: target, content: "# API" } }).kind, "allow");
			}
			for (const target of [join(cwd, "api.md"), join(`${outputDir}-sibling`, "api.md")]) {
				const decision = policy.evaluate({ tool: ToolNames.Write, args: { path: target, content: "# API" } });
				assert.equal(decision.kind, "block");
				assert.equal(decision.reasonCode, "write-root");
			}
			assert.deepEqual(scope.writeBoundaries, [asDirectoryPathBoundary(outputDir)]);
			assert.equal(
				classifyDispatchIntentCompatibility(spec).some((finding) => finding.decision === "refuse"),
				false,
			);
			assert.deepEqual(spec.writeRoots, [asDirectoryPathBoundary(outputDir)]);
			assert.deepEqual(spec.denyTools, [ToolNames.Git]);
			assert.equal(spec.autonomy, undefined);
			assert.equal(spec.noSkills, true);
			assert.equal(spec.requestOrigin, "internal");
			assert.ok((spec.assignmentDeadlineAt ?? 0) > Date.now());
		}
		assert.equal(readWikiPlanFile(outputDir)?.pages[0]?.status, "written");
		const request = requests[1];
		assert.ok(request);
		// The real generated page prompt carries a sentence ending in an absolute
		// page filename. Without typed intent, the production legacy seam refuses it.
		const legacy = { ...request };
		delete legacy.intent;
		assert.throws(() => resolveDispatchPathScope(legacy), /legacy_scope_path_absolute/u);
		for (const invalidOutput of [cwd, join(isolated.dir, "outside")]) {
			mkdirSync(invalidOutput, { recursive: true });
			await generate({ ...input, outputDir: invalidOutput, resumed: true });
			assert.equal(requests.length, 2, "invalid staging scope never reaches dispatch");
		}
	} finally {
		process.chdir(originalCwd);
		await isolated.restore();
	}
});
