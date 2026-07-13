import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import type { RunOutcomeCode } from "../../src/domains/dispatch/types.js";

describe("contracts/dispatch retry fail-fast classifier", () => {
	it("suppresses every typed deterministic terminal condition", () => {
		const codes: RunOutcomeCode[] = [
			"vram_capacity_fit_failure",
			"worker_tool_call_cap_exhausted",
			"loop_guard_tools_disabled_exhausted",
			"scout_synthesis_contract_exhausted",
		];
		for (const code of codes) strictEqual(isDeterministicOutcomeCode(code), true);
	});

	it("does not classify absent or unrelated values", () => {
		strictEqual(isDeterministicOutcomeCode(null), false);
		strictEqual(isDeterministicOutcomeCode(undefined), false);
	});
});
