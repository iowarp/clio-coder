import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Interview, InterviewAnswer } from "../../src/domains/extensions/public-api-v2.js";
import type { AskUserAnswer } from "../../src/tools/ask-user.js";
import { runExtensionInterview } from "../../src/tools/extension-interview.js";

const interview: Interview = {
	id: "gate",
	title: "Gate",
	step: {
		key: "confirm",
		questions: [
			{
				id: "choice",
				label: "Plan",
				kind: "single",
				options: [
					{ value: "approve", label: "Approve" },
					{ value: "revise", label: "Revise" },
				],
			},
		],
	},
};

async function answerWith(answer: AskUserAnswer): Promise<InterviewAnswer | undefined> {
	let received: InterviewAnswer | undefined;
	await runExtensionInterview(
		{ ask: async () => ({ answers: [answer] }) },
		interview,
		{ extensionId: "desk", title: "Desk" },
		async (next) => {
			received = next;
			return { done: true, text: "ok" };
		},
	);
	return received;
}

test("an interview answer keeps the chosen option and carries an attached note beside it", async () => {
	const withNote = await answerWith({
		question: "Plan",
		answer: "Revise; tighten Task 1",
		options: ["Revise"],
		value: "tighten Task 1",
	});
	deepStrictEqual(withNote, {
		id: "gate",
		step: "confirm",
		answers: { choice: "revise" },
		notes: { choice: "tighten Task 1" },
		nav: "next",
	});
	const other = await answerWith({ question: "Plan", answer: "something else", value: "something else" });
	deepStrictEqual(other, {
		id: "gate",
		step: "confirm",
		answers: { choice: "something else" },
		other: { choice: true },
		nav: "next",
	});
	const plain = await answerWith({ question: "Plan", answer: "Approve", options: ["Approve"] });
	deepStrictEqual(plain, { id: "gate", step: "confirm", answers: { choice: "approve" }, nav: "next" });
});
