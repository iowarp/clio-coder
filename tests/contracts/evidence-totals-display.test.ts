import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { renderEvidenceTokens } from "../../src/domains/evidence/totals-display.js";

test("a bundle's sealed tokens read as a lower bound whenever its coverage names a gap (#434, L3)", () => {
	strictEqual(renderEvidenceTokens({ tokens: 1234 }), "1,234");
	strictEqual(renderEvidenceTokens({ tokens: 1234, tokenCoverage: { unknownCalls: 0, unknownRuns: 0 } }), "1,234");
	strictEqual(
		renderEvidenceTokens({ tokens: 1234, tokenCoverage: { unknownCalls: 1, unknownRuns: 0 } }),
		"≥1,234 (1 call unmeasured)",
	);
	strictEqual(
		renderEvidenceTokens({ tokens: 1234, tokenCoverage: { unknownCalls: 2, unknownRuns: 3 } }, { unit: " tokens" }),
		"≥1,234 tokens (2 calls, 3 runs unmeasured)",
	);
	// A surface picks only the count formatter; the coverage marker is not its to change.
	strictEqual(
		renderEvidenceTokens(
			{ tokens: 12_345, tokenCoverage: { unknownCalls: 0, unknownRuns: 1 } },
			{ count: () => "12.3k" },
		),
		"≥12.3k (1 run unmeasured)",
	);
});
