import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { runBoundaryCheck } from "./check-boundaries.js";

const PROJECT_ROOT = new URL("../..", import.meta.url).pathname;

describe("boundaries", () => {
	it("no rule1/rule2/rule3 violations across src/", () => {
		const result = runBoundaryCheck(PROJECT_ROOT);
		if (result.violations.length > 0) {
			console.error("Boundary violations:");
			for (const v of result.violations) console.error(`  ${v}`);
		}
		strictEqual(result.violations.length, 0);
	});
});
