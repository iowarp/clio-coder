import { deepEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { THINKING_LEVELS } from "../../src/core/defaults.js";
import { VALID_THINKING_LEVELS } from "../../src/domains/providers/types/capability-flags.js";

describe("contracts/thinking-levels", () => {
	it("maintains an exhaustive, identical thinking level list across core and provider domains", () => {
		const expected = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		deepEqual([...THINKING_LEVELS], expected);
		deepEqual([...VALID_THINKING_LEVELS], expected);
	});
});
