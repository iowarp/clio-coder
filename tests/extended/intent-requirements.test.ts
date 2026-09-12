import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchIntent } from "../../src/domains/dispatch/intent.js";
import { renderDispatchIntentRequirements } from "../../src/domains/dispatch/intent-requirements.js";

function intent(overrides: Partial<DispatchIntent>): DispatchIntent {
	return {
		version: 2,
		readRoots: [],
		writeRoots: [],
		relevantPaths: [],
		pathProvenance: [],
		expectedOutputs: [],
		verification: [],
		...overrides,
	};
}

describe("declared result requirements", () => {
	it("tells a write-confined worker that it has no shell and the host runs the checks", () => {
		const block = renderDispatchIntentRequirements(
			intent({
				writeRoots: ["src/compaction.ts"],
				expectedOutputs: ["src/compaction.ts"],
				verification: [{ check: "typecheck", timeoutMs: 120_000 }],
			}),
		);
		match(block ?? "", /no bash or verify tool/u);
		match(block ?? "", /the host runs the declared checks/u);
		match(block ?? "", /typecheck must pass/u);
	});

	it("says nothing about confinement when no write root is declared", () => {
		const block = renderDispatchIntentRequirements(intent({ expectedOutputs: ["REPORT.md"] }));
		doesNotMatch(block ?? "", /no bash or verify tool/u);
		strictEqual(renderDispatchIntentRequirements(intent({})), null);
	});
});
