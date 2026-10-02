import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { askMergeCard } from "../../src/domains/dispatch/merge-card.js";
import { validationClause } from "../../src/domains/evidence/trust-projection.js";
import { adaptRunReceiptValidationStatus } from "../../src/domains/evidence/trust-status.js";
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
	const outcome = await askMergeCard({ ask }, INPUT);
	deepStrictEqual(outcome, { choice: "keep", cause: "answered" });
	deepStrictEqual(asked.map(labelAt), ["Keep branch", "Back", "Keep branch"]);
});

test("Merge and a confirmed Delete are the only destructive outcomes; Esc keeps the branch", async () => {
	deepStrictEqual(await askMergeCard({ ask: scripted([pick("Merge")]).ask }, INPUT), {
		choice: "merge",
		cause: "answered",
	});
	deepStrictEqual(await askMergeCard({ ask: scripted([pick("Discard"), pick("Delete")]).ask }, INPUT), {
		choice: "discard",
		cause: "answered",
	});
	deepStrictEqual(await askMergeCard({ ask: scripted([{ answers: [], cancelled: true }]).ask }, INPUT), {
		choice: "keep",
		cause: "escaped",
	});
});

test("a screen another overlay holds delays the card instead of settling it", async () => {
	const { ask, asked } = scripted([{ answers: [], cancelled: true, unavailable: true }, pick("Merge")]);
	const outcome = await askMergeCard({ ask, retryMs: 1 }, INPUT);
	strictEqual(outcome.choice, "merge");
	strictEqual(asked.length, 2);
});

test("a branch that changes protected paths is not offered a Merge, and the card says why", async () => {
	const { ask, asked } = scripted([pick("Merge")]);
	const outcome = await askMergeCard({ ask }, { ...INPUT, protectedPaths: ["docs/policy.md"] });
	deepStrictEqual(
		asked[0]?.options?.map((option) => option.label),
		["Keep branch", "Discard"],
	);
	strictEqual(labelAt(asked[0]), "Keep branch");
	strictEqual(asked[0]?.question.includes("docs/policy.md"), true);
	deepStrictEqual(outcome, { choice: "keep", cause: "unlisted" });
});

test("the merge card distinguishes a host failure also observed on the base", async () => {
	const { ask, asked } = scripted([pick("Keep branch")]);
	await askMergeCard(
		{ ask },
		{
			...INPUT,
			workerFailedChecks: ["test"],
			hostVerification: {
				status: "rejected",
				checks: [
					{
						check: "test",
						argv: ["npm", "test"],
						cwd: ".",
						exitCode: 1,
						durationMs: 10,
						memo: false,
						outputTail: "failure",
						baseComparison: { status: "failed", base: "base-sha", exitCode: 1 },
					},
				],
			},
		},
	);
	match(asked[0]?.question ?? "", /Worker-reported check 'test': the check also fails on base base-sha/);
	match(asked[0]?.question ?? "", /does not establish that the worker caused/);
});

test("a host failure also observed on the base leaves quality unknown, not failed", () => {
	const check = {
		check: "test",
		argv: ["npm", "test"],
		cwd: ".",
		exitCode: 1,
		durationMs: 10,
		memo: false,
		outputTail: "failure",
	};
	const status = (baseComparison: { status: "passed" | "failed"; base: string; exitCode: number }) =>
		adaptRunReceiptValidationStatus({
			runId: "run-1",
			hostVerification: { status: "rejected", checks: [{ ...check, baseComparison }] },
		}).state;
	strictEqual(status({ status: "failed", base: "base-sha", exitCode: 1 }), "unknown");
	strictEqual(status({ status: "passed", base: "base-sha", exitCode: 0 }), "failed");
});

test("a confirmed baseline failure is explained by the shared validation projection", () => {
	const validationGrounding = adaptRunReceiptValidationStatus({
		runId: "baseline-run",
		hostVerification: {
			status: "rejected",
			checks: [
				{
					check: "test",
					argv: ["npm", "test"],
					cwd: ".",
					exitCode: 1,
					durationMs: 10,
					memo: false,
					outputTail: "failure",
					baseComparison: { status: "failed", base: "base-sha", exitCode: 1 },
				},
			],
		},
	});
	strictEqual(validationGrounding.state, "unknown");
	match(validationClause({ validationGrounding }), /also failed on task base; change validation unknown/);
});
