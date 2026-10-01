import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { askMergeCard } from "../../src/domains/dispatch/merge-card.js";
import type { AskUserHandler, AskUserQuestion, AskUserResult } from "../../src/tools/ask-user.js";

const INPUT = { branch: "clio/task-1", changedPaths: ["src/a.ts"], reason: "the report claims no check" };

function pick(label: string): AskUserResult {
	return { answers: [{ question: "q", answer: label, options: [label] }] };
}

function scripted(replies: AskUserResult[]): { ask: AskUserHandler; asked: AskUserQuestion[] } {
	const asked: AskUserQuestion[] = [];
	const ask: AskUserHandler = async (questions) => {
		const question = questions[0];
		if (question !== undefined) asked.push(question);
		return replies.shift() ?? { answers: [], cancelled: true };
	};
	return { ask, asked };
}

function labelAt(question: AskUserQuestion | undefined): string | undefined {
	const index = question?.defaultOption;
	return index === undefined ? undefined : question?.options?.[index]?.label;
}

test("the card opens on Keep branch and the discard confirm opens on Back", async () => {
	const { ask, asked } = scripted([pick("Discard"), pick("Back"), pick("Keep branch")]);
	const outcome = await askMergeCard({ ask, timeoutMs: 5_000 }, INPUT);
	deepStrictEqual(outcome, { choice: "keep", cause: "answered" });
	deepStrictEqual(asked.map(labelAt), ["Keep branch", "Back", "Keep branch"]);
});

test("Merge and a confirmed Delete are the only destructive outcomes; Esc keeps the branch", async () => {
	deepStrictEqual(await askMergeCard({ ask: scripted([pick("Merge")]).ask, timeoutMs: 5_000 }, INPUT), {
		choice: "merge",
		cause: "answered",
	});
	deepStrictEqual(
		await askMergeCard({ ask: scripted([pick("Discard"), pick("Delete")]).ask, timeoutMs: 5_000 }, INPUT),
		{
			choice: "discard",
			cause: "answered",
		},
	);
	deepStrictEqual(
		await askMergeCard({ ask: scripted([{ answers: [], cancelled: true }]).ask, timeoutMs: 5_000 }, INPUT),
		{
			choice: "keep",
			cause: "escaped",
		},
	);
});

test("a screen another overlay holds delays the card instead of settling it", async () => {
	const { ask, asked } = scripted([{ answers: [], cancelled: true, unavailable: true }, pick("Merge")]);
	const outcome = await askMergeCard({ ask, timeoutMs: 5_000, retryMs: 1 }, INPUT);
	strictEqual(outcome.choice, "merge");
	strictEqual(asked.length, 2);
});
