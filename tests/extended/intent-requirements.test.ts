import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { WithheldCapability } from "../../src/domains/dispatch/envelope.js";
import type { DispatchIntent } from "../../src/domains/dispatch/intent.js";
import {
	renderDispatchIntentRequirements,
	renderWithheldNotice,
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

function unconfined(...tools: string[]): WithheldCapability[] {
	return tools.map((capability) => ({ capability, reason: "write-roots-unconfined" }));
}

describe("declared result requirements", () => {
	it("tells a write-confined worker which check tools it lost and that the host runs the checks", () => {
		const withRequirements = intent({
			writeRoots: ["src/compaction.ts"],
			expectedOutputs: ["src/compaction.ts"],
			verification: [{ check: "typecheck", timeoutMs: 120_000 }],
		});
		const notice = renderWithheldNotice(unconfined("bash", "verify"), withRequirements);
		match(notice ?? "", /^- bash: the write roots have no sandbox or worktree/mu);
		match(notice ?? "", /Without bash, verify you cannot run tests/u);
		match(notice ?? "", /the host runs the declared checks/u);
		match(renderDispatchIntentRequirements(withRequirements) ?? "", /typecheck must pass/u);
		// Write roots alone still produce the notice: no requirements block carries it (CLI-H2).
		match(renderWithheldNotice(unconfined("bash"), intent({ writeRoots: ["a.js"] })) ?? "", /Without bash you/u);
	});

	it("drops the notice when admission withheld nothing", () => {
		strictEqual(renderWithheldNotice([], intent({ writeRoots: ["src/duration.js"] })), null);
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
