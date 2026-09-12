import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeEvidenceIndex } from "../../src/domains/observability/accountability.js";
import type { EvidenceIndexRow } from "../../src/domains/observability/evidence-index.js";

function row(runId: string, fields: Partial<EvidenceIndexRow> = {}): EvidenceIndexRow {
	return {
		runId,
		evidenceId: `run-${runId}`,
		firstPassSuccess: true,
		tags: [],
		findingCount: 0,
		generatedAt: "2026-09-05T00:00:00.000Z",
		...fields,
	};
}

describe("accountability evidence fold", () => {
	it("returns zero counters for an empty index", () => {
		deepStrictEqual(summarizeEvidenceIndex([]), {
			totalRuns: 0,
			firstPassRuns: 0,
			firstPassRate: 0,
			unverifiedSuccesses: 0,
			ungroundedClaims: 0,
			failureCauses: [],
		});
	});

	it("counts each unverified success once and claims across all outcomes", () => {
		const summary = summarizeEvidenceIndex([
			row("none", { succeeded: true, tags: ["no-validation"], ungroundedClaims: 2 }),
			row("proxy", { succeeded: true, tags: ["proxy-validation"], ungroundedClaims: 3 }),
			row("completion", { succeeded: true, tags: ["completion-evidence"], completionEvidenceWarning: true }),
			row("overlap", {
				succeeded: true,
				tags: ["no-validation", "proxy-validation", "completion-evidence"],
				completionEvidenceWarning: true,
				ungroundedClaims: 1,
			}),
			row("failed", {
				succeeded: false,
				firstPassSuccess: false,
				tags: ["no-validation", "test-failure"],
				completionEvidenceWarning: true,
				ungroundedClaims: 4,
			}),
			row("info", { succeeded: true, tags: ["completion-evidence"], completionEvidenceWarning: false }),
			row("grounded", { succeeded: true, ungroundedClaims: 0 }),
			row("historical", { tags: ["no-validation", "completion-evidence"] }),
		]);
		strictEqual(summary.totalRuns, 8);
		strictEqual(summary.firstPassRuns, 7);
		strictEqual(summary.firstPassRate, 7 / 8);
		strictEqual(summary.unverifiedSuccesses, 4);
		strictEqual(summary.ungroundedClaims, 10);
		deepStrictEqual(summary.failureCauses, [{ tag: "test-failure", count: 1 }]);
	});
});
