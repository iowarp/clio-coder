import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	claimToolMarkupReprompt,
	EMPTY_ANSWER_REPROMPT_NOTICE_KEY,
	noAnswerReprompt,
	TOOL_MARKUP_REPROMPT_CAP,
	TOOL_MARKUP_REPROMPT_NOTICE_KEY,
} from "../../src/session-control/chat-loop-messages.js";

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

test("a reply with no answer and no call is re-prompted like a written-out call, and an answer is not", () => {
	for (const cause of ["reasoning_only", "empty"] as const)
		strictEqual(noAnswerReprompt({ kind: "no_answer", cause, toolsRan: 0 })?.noticeKey, EMPTY_ANSWER_REPROMPT_NOTICE_KEY);
	strictEqual(
		noAnswerReprompt({ kind: "no_answer", cause: "tool_call_in_reasoning", toolsRan: 0 })?.noticeKey,
		TOOL_MARKUP_REPROMPT_NOTICE_KEY,
	);
	strictEqual(noAnswerReprompt({ kind: "quiet", toolsRan: 2 }), null);
	strictEqual(noAnswerReprompt(null), null);
});
