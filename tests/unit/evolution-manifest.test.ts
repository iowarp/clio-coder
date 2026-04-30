import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type ChangeManifest,
	createChangeManifestTemplate,
	FIRST_EXPLORATORY_ITERATION_ID,
	type ManifestChange,
	summarizeChangeManifest,
	validateChangeManifest,
} from "../../src/domains/evolution/index.js";

describe("evolution change manifest validation", () => {
	it("accepts a valid manifest and summarizes it deterministically", () => {
		const manifest = validManifest({
			changes: [
				validChange({
					id: "change-b",
					componentIds: ["tool-implementation:src/tools/bash.ts"],
					filesChanged: ["src/tools/bash.ts"],
					authorityLevel: "tool-implementation",
					predictedRegressions: ["bash command approval behavior changes"],
					validationPlan: ["npm run test", "npm run test:e2e"],
				}),
				validChange({
					id: "change-a",
					componentIds: ["context-file:CLIO.md"],
					filesChanged: ["CLIO.md"],
					authorityLevel: "prompt",
					predictedRegressions: [],
					validationPlan: ["npm run lint"],
				}),
			],
		});

		const result = validateChangeManifest(manifest);
		strictEqual(result.valid, true);
		if (!result.valid) throw new Error("expected manifest to validate");
		deepStrictEqual(summarizeChangeManifest(result.manifest), {
			iterationId: "iter-2026-04-29",
			baseGitSha: "abc123",
			changeCount: 2,
			authorityLevels: ["prompt", "tool-implementation"],
			componentIds: ["context-file:CLIO.md", "tool-implementation:src/tools/bash.ts"],
			filesChanged: ["CLIO.md", "src/tools/bash.ts"],
			predictedRegressions: ["bash command approval behavior changes"],
			validationPlanCount: 3,
		});
	});

	it("reports missing required manifest fields", () => {
		const result = validateChangeManifest({
			version: 1,
			createdAt: "2026-04-29T00:00:00.000Z",
		});

		strictEqual(result.valid, false);
		deepStrictEqual(issuePaths(result), ["$.iterationId", "$.baseGitSha", "$.changes"]);
	});

	it("requires every change to reference a component or file", () => {
		const result = validateChangeManifest(
			validManifest({
				changes: [validChange({ componentIds: [], filesChanged: [] })],
			}),
		);

		strictEqual(result.valid, false);
		ok(issueText(result).some((issue) => issue.includes("$.changes[0]: requires at least one")));
	});

	it("requires a non-empty rollback plan", () => {
		const result = validateChangeManifest(
			validManifest({
				changes: [validChange({ rollbackPlan: "   " })],
			}),
		);

		strictEqual(result.valid, false);
		ok(issueText(result).some((issue) => issue.includes("$.changes[0].rollbackPlan: expected non-empty string")));
	});

	it("requires high-authority changes to predict at least one regression", () => {
		const result = validateChangeManifest(
			validManifest({
				changes: [
					validChange({
						authorityLevel: "cli",
						predictedRegressions: [],
					}),
				],
			}),
		);

		strictEqual(result.valid, false);
		ok(
			issueText(result).some((issue) =>
				issue.includes("$.changes[0].predictedRegressions: high-authority changes require an entry"),
			),
		);
	});

	it("allows explicit empty evidence refs only for the first exploratory iteration", () => {
		const exploratory = validateChangeManifest(
			validManifest({
				iterationId: FIRST_EXPLORATORY_ITERATION_ID,
				changes: [validChange({ evidenceRefs: [] })],
			}),
		);
		strictEqual(exploratory.valid, true);

		const ordinary = validateChangeManifest(
			validManifest({
				changes: [validChange({ evidenceRefs: [] })],
			}),
		);
		strictEqual(ordinary.valid, false);
		ok(issueText(ordinary).some((issue) => issue.includes("empty evidence refs are allowed only for exploratory-1")));
	});

	it("rejects invalid expected budget impact risk values", () => {
		const result = validateChangeManifest({
			...validManifest(),
			changes: [
				{
					...validChange(),
					expectedBudgetImpact: {
						risk: "faster",
					},
				},
			],
		});

		strictEqual(result.valid, false);
		ok(issueText(result).some((issue) => issue.includes("$.changes[0].expectedBudgetImpact.risk")));
	});

	it("emits a valid deterministic init template", () => {
		const template = createChangeManifestTemplate();
		const first = JSON.stringify(template, null, 2);
		const second = JSON.stringify(createChangeManifestTemplate(), null, 2);
		strictEqual(first, second);
		strictEqual(validateChangeManifest(template).valid, true);
	});
});

function validManifest(overrides: Partial<ChangeManifest> = {}): ChangeManifest {
	return {
		version: 1,
		iterationId: "iter-2026-04-29",
		baseGitSha: "abc123",
		createdAt: "2026-04-29T00:00:00.000Z",
		changes: [validChange()],
		...overrides,
	};
}

function validChange(overrides: Partial<ManifestChange> = {}): ManifestChange {
	return {
		id: "change-1",
		componentIds: ["context-file:CLIO.md"],
		filesChanged: ["CLIO.md"],
		authorityLevel: "prompt",
		evidenceRefs: ["manual:evidence-1"],
		rootCause: "The current harness behavior is not observable enough.",
		targetedFix: "Add a typed, reviewable manifest.",
		predictedFixes: ["Improvement proposals become auditable."],
		predictedRegressions: [],
		validationPlan: ["npm run test"],
		rollbackPlan: "Revert this change.",
		...overrides,
	};
}

function issuePaths(result: ReturnType<typeof validateChangeManifest>): string[] {
	return result.issues.map((issue) => issue.path);
}

function issueText(result: ReturnType<typeof validateChangeManifest>): string[] {
	return result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}
