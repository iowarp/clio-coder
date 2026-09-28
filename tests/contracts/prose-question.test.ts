import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createProseQuestionRegistration,
	PLAN_APPROVAL_CONTINUATION_MESSAGE,
	PROSE_QUESTION_CONTINUATION_MESSAGE,
} from "../../src/domains/middleware/prose-question.js";

function check(request: string, answer: string) {
	const registration = createProseQuestionRegistration({ askUserAvailable: () => true });
	registration.evaluate({ hook: "turn_start", text: request });
	return registration.evaluate({ hook: "turn_end", text: answer, metadata: { stopReason: "stop" } });
}

describe("operator questions at turn close", () => {
	it("continues a real closing question and an offered choice", () => {
		deepStrictEqual(check("inspect this", "I found two choices. Which one should I use?"), [
			{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE },
		]);
		deepStrictEqual(check("inspect this", "I can fix it now. Let me know when you're ready."), [
			{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE },
		]);
	});

	it("does not convert an explanation about plans or a answered rhetorical question into an approval", () => {
		const longAnswer = `${"A plan can help organize this work. ".repeat(20)}The current implementation is ready for review.`;
		deepStrictEqual(check("explain the plan format", longAnswer), []);
		deepStrictEqual(check("inspect this", "Why use a cache? It avoids repeated work."), []);
	});

	it("asks approval for a requested plan and stops after one continuation", () => {
		const registration = createProseQuestionRegistration({ askUserAvailable: () => true });
		registration.evaluate({ hook: "turn_start", text: "plan how to add a filter" });
		deepStrictEqual(
			registration.evaluate({ hook: "turn_end", text: "Step one. ".repeat(60), metadata: { stopReason: "stop" } }),
			[{ kind: "request_continuation", message: PLAN_APPROVAL_CONTINUATION_MESSAGE }],
		);
		deepStrictEqual(
			registration.evaluate({ hook: "turn_end", text: "Anything else?", metadata: { stopReason: "stop" } }),
			[],
		);
	});
});
