import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	claimToolMarkupReprompt,
	EMPTY_ANSWER_REPROMPT_NOTICE_KEY,
	noAnswerReprompt,
	rebaseToolMarkupReprompt,
	TOOL_MARKUP_REPROMPT_CAP,
	TOOL_MARKUP_REPROMPT_NOTICE_KEY,
	toolCallLabel,
} from "../../src/session-control/chat-loop-messages.js";

test("written-out tool calls are capped only when back to back, and a real call resets the count", () => {
	// Markup, native, markup, native, markup, native, markup: every one is re-prompted.
	let budget = null as ReturnType<typeof claimToolMarkupReprompt>;
	for (let calls = 4; calls < 8; calls++) {
		budget = claimToolMarkupReprompt(budget, "turn-1", calls);
		deepStrictEqual(budget, { turnId: "turn-1", count: 1, toolCallsAt: calls });
	}
	// Back to back with no real call between: re-prompted up to the cap, then the turn ends.
	for (let count = 2; count <= TOOL_MARKUP_REPROMPT_CAP; count++) {
		budget = claimToolMarkupReprompt(budget, "turn-1", 7);
		strictEqual(budget?.count, count);
	}
	strictEqual(claimToolMarkupReprompt(budget, "turn-1", 7), null);
	// A new operator turn starts a fresh budget.
	deepStrictEqual(claimToolMarkupReprompt(budget, "turn-2", 7), { turnId: "turn-2", count: 1, toolCallsAt: 7 });
	// A continuation zeroes the per-run tool count; the rebased budget does not read that as a real call (x2-2).
	const rebased = rebaseToolMarkupReprompt(budget);
	strictEqual(claimToolMarkupReprompt(rebased, "turn-1", 0), null);
	strictEqual(claimToolMarkupReprompt(rebased, "turn-1", 1)?.count, 1);
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

test("the written-out-call nudge names the calls that already ran this turn, so an applied edit is not redone (SC-1)", () => {
	const ran = [toolCallLabel("edit", { path: "src/x.py" }), toolCallLabel("bash", { command: "pytest -q" })];
	deepStrictEqual(ran, ["edit src/x.py", "bash `pytest -q`"]);
	const reminder = noAnswerReprompt({ kind: "no_answer", cause: "tool_call_as_text", toolsRan: 2 }, ran)?.reminder ?? "";
	ok(reminder.includes("edit src/x.py; bash `pytest -q`"), reminder);
	ok(reminder.includes("do not repeat them"), reminder);
	// Nothing ran: the nudge stays as it was, and an empty reply never lists calls.
	ok(
		!(noAnswerReprompt({ kind: "no_answer", cause: "tool_call_as_text", toolsRan: 0 }, [])?.reminder ?? "").includes(
			"already ran",
		),
	);
	ok(
		!(noAnswerReprompt({ kind: "no_answer", cause: "empty", toolsRan: 2 }, ran)?.reminder ?? "").includes("already ran"),
	);
});
