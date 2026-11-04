import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { oneShotTokens } from "../../src/domains/providers/one-shot.js";

test("a one-shot's tokens count the cached prompt it read", () => {
	// The shape a subscription round reported live for a 94-file filter: almost all of the prompt was a cache hit.
	deepStrictEqual(oneShotTokens({ input: 4, output: 12, cacheRead: 22_056, cacheWrite: 0 }), {
		input: 22_060,
		output: 12,
	});
	deepStrictEqual(oneShotTokens({ input: 4, output: 337, cacheRead: 0, cacheWrite: 14_415 }), {
		input: 14_419,
		output: 337,
	});
	deepStrictEqual(oneShotTokens({ input: 276, output: 28 }), { input: 276, output: 28 });
});
