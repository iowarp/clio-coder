import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { claimToolMarkupReprompt, TOOL_MARKUP_REPROMPT_CAP } from "../../src/session-control/chat-loop-messages.js";

test("a written-out tool call is re-prompted again only after a real call ran, up to the cap", () => {
	const first = claimToolMarkupReprompt(null, "turn-1", 4);
	deepStrictEqual(first, { turnId: "turn-1", count: 1, toolCallsAt: 4 });
	// Back to back with no real call in between: the turn ends.
	strictEqual(claimToolMarkupReprompt(first, "turn-1", 4), null);
	// The model recovered and made calls, then wrote markup again.
	let budget = claimToolMarkupReprompt(first, "turn-1", 7);
	deepStrictEqual(budget, { turnId: "turn-1", count: 2, toolCallsAt: 7 });
	for (let calls = 8; budget !== null && budget.count < TOOL_MARKUP_REPROMPT_CAP; calls++)
		budget = claimToolMarkupReprompt(budget, "turn-1", calls);
	strictEqual(budget?.count, TOOL_MARKUP_REPROMPT_CAP);
	strictEqual(claimToolMarkupReprompt(budget, "turn-1", 99), null);
	// A new operator turn starts a fresh budget.
	deepStrictEqual(claimToolMarkupReprompt(budget, "turn-2", 0), { turnId: "turn-2", count: 1, toolCallsAt: 0 });
});
