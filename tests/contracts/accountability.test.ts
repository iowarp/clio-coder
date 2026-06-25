import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeEvidenceIndex } from "../../src/domains/observability/accountability.js";
import type { EvidenceIndexRow } from "../../src/domains/observability/evidence-index.js";

function row(partial: Partial<EvidenceIndexRow> & Pick<EvidenceIndexRow, "runId">): EvidenceIndexRow {
	return {
		evidenceId: `run-${partial.runId}`,
		tags: [],
		firstPassSuccess: false,
		findingCount: 0,
		generatedAt: "2026-06-25T00:00:00.000Z",
		...partial,
	};
}

describe("contracts/accountability", () => {
	it("yields the empty summary for empty rows", () => {
		deepStrictEqual(summarizeEvidenceIndex([]), {
			totalRuns: 0,
			firstPassRuns: 0,
			firstPassRate: 0,
			failureCauses: [],
		});
	});

	it("counts totals, first-pass runs, rate, and a sorted failure-cause histogram", () => {
		const rows: EvidenceIndexRow[] = [
			row({ runId: "1", firstPassSuccess: true, tags: ["audit-linked"] }),
			row({ runId: "2", firstPassSuccess: false, tags: ["test-failure", "no-validation"] }),
			row({ runId: "3", firstPassSuccess: false, tags: ["test-failure"] }),
			row({ runId: "4", firstPassSuccess: true, tags: ["test-failure", "build-failure"] }),
		];

		const summary = summarizeEvidenceIndex(rows);
		strictEqual(summary.totalRuns, 4);
		strictEqual(summary.firstPassRuns, 2);
		strictEqual(summary.firstPassRate, 0.5);
		// test-failure occurs 3x (highest); provenance/quality tags such as
		// audit-linked and no-validation are evidence tags, not failure causes.
		deepStrictEqual(summary.failureCauses, [
			{ tag: "test-failure", count: 3 },
			{ tag: "build-failure", count: 1 },
		]);
	});

	it("is deterministic across runs", () => {
		const rows: EvidenceIndexRow[] = [
			row({ runId: "a", tags: ["auth-failure", "timeout"] }),
			row({ runId: "b", tags: ["timeout"] }),
		];
		deepStrictEqual(summarizeEvidenceIndex(rows), summarizeEvidenceIndex(rows));
	});
});
