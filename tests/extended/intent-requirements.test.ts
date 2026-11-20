import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchIntent } from "../../src/domains/dispatch/intent.js";
import {
	renderChecksWithheldNotice,
	renderDispatchIntentRequirements,
} from "../../src/domains/dispatch/intent-requirements.js";

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
	it("tells a write-confined worker which check tools it lost and that the host runs the checks", () => {
		const withRequirements = intent({
			writeRoots: ["src/compaction.ts"],
			expectedOutputs: ["src/compaction.ts"],
			verification: [{ check: "typecheck", timeoutMs: 120_000 }],
		});
		const notice = renderChecksWithheldNotice(["bash", "verify"], withRequirements);
		match(notice ?? "", /bash, verify are withheld/u);
		match(notice ?? "", /the host runs the declared checks/u);
		match(renderDispatchIntentRequirements(withRequirements) ?? "", /typecheck must pass/u);
		// Write roots alone still produce the notice: no requirements block carries it (CLI-H2).
		match(renderChecksWithheldNotice(["bash"], intent({ writeRoots: ["a.js"] })) ?? "", /bash is withheld/u);
	});

	it("drops the notice when admission withheld nothing", () => {
		strictEqual(renderChecksWithheldNotice([], intent({ writeRoots: ["src/duration.js"] })), null);
		const block = renderDispatchIntentRequirements(
			intent({ writeRoots: ["src/duration.js"], expectedOutputs: ["src/duration.js"] }),
		);
		doesNotMatch(block ?? "", /withheld/u);
		match(block ?? "", /Expected outputs:/u);
	});

	it("says nothing about confinement when no write root is declared", () => {
		const block = renderDispatchIntentRequirements(intent({ expectedOutputs: ["REPORT.md"] }));
		doesNotMatch(block ?? "", /withheld/u);
		strictEqual(renderDispatchIntentRequirements(intent({})), null);
	});
});
