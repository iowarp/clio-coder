import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { mapExitCode } from "../../src/cli/run.js";
import { validateResultContract } from "../../src/domains/agents/result-contract.js";
import { askMergeCard } from "../../src/domains/dispatch/merge-card.js";
import { mergeWithheldDetail } from "../../src/domains/dispatch/merge-gate.js";
import { receiptAssurance } from "../../src/domains/dispatch/run-settlement.js";
import type { RunResult } from "../../src/domains/dispatch/types.js";
import { trustVerdict, validationClause } from "../../src/domains/evidence/trust-projection.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import type { AskUserHandler, AskUserQuestion, AskUserResult } from "../../src/tools/ask-user.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { settledRunTrust } from "../harness/settled-run.js";

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

test("Land and a confirmed Delete are the only destructive outcomes; Esc keeps the branch", async () => {
	deepStrictEqual(await askMergeCard({ ask: scripted([pick("Land")]).ask }, INPUT), {
		choice: "land",
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
	const { ask, asked } = scripted([{ answers: [], cancelled: true, unavailable: true }, pick("Land")]);
	const outcome = await askMergeCard({ ask, retryMs: 1 }, INPUT);
	strictEqual(outcome.choice, "land");
	strictEqual(asked.length, 2);
});

test("elapsed screen retries release their abort listeners", async () => {
	let attempts = 0;
	const keepAlive = setInterval(() => {}, 1000);
	try {
		const outcome = await askMergeCard(
			{
				retryMs: 1,
				ask: async (_questions, options) => {
					strictEqual(getEventListeners(options?.signal as AbortSignal, "abort").length, 0);
					return ++attempts < 15 ? { answers: [], unavailable: true } : pick("Keep branch");
				},
			},
			INPUT,
		);
		strictEqual(outcome.choice, "keep");
		strictEqual(attempts, 15);
	} finally {
		clearInterval(keepAlive);
	}
});

test("a branch that changes protected paths is not offered a Land, and the card says why", async () => {
	const { ask, asked } = scripted([pick("Land")]);
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
		settledRunTrust({
			...fixtureReceiptDraft(fixtureEnvelope()),
			...{
				runId: "run-1",
				hostVerification: { status: "rejected", checks: [{ ...check, baseComparison }] },
			},
		}).validationGrounding.state;
	strictEqual(status({ status: "failed", base: "base-sha", exitCode: 1 }), "unknown");
	strictEqual(status({ status: "passed", base: "base-sha", exitCode: 0 }), "failed");
});

test("a confirmed baseline failure is explained by the shared validation projection", () => {
	const validationGrounding = settledRunTrust({
		...fixtureReceiptDraft(fixtureEnvelope()),
		...{
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
		},
	}).validationGrounding;
	strictEqual(validationGrounding.state, "unknown");
	match(validationClause({ validationGrounding }), /also failed on task base; change validation unknown/);
});

test("host verification passed and the worker's own check failed: merge, exit code and card agree (M9)", async () => {
	// The worker edits, then sees its own `npm test` fail on the final tree; the host's declared check passes.
	const recorder = createRunEffectsRecorder(process.cwd());
	recorder.start("fix", "edit", { path: "src/a.ts" });
	recorder.finish("fix", false);
	recorder.start("red", "bash", { command: "npm test" });
	recorder.checkOutcome("red", "error");
	recorder.finish("red", true);
	const contract = { kind: "mutation-report" } as const;
	const output = JSON.stringify({
		completion: { state: "done", limitations: [], unverified: [] },
		mutatedPaths: ["src/a.ts"],
		validations: [{ name: "npm test", passed: false, evidence: "exit 1" }],
	});
	const resultContract = validateResultContract({
		contract,
		output,
		cwd: process.cwd(),
		networkAllowed: false,
		filesystem: { readFile: () => "" },
		observedRunEffects: recorder.snapshot(),
	});
	const draft = {
		...fixtureReceiptDraft(fixtureEnvelope()),
		quality: { ...fixtureReceiptDraft(fixtureEnvelope()).quality, resultContract },
		hostVerification: {
			status: "verified" as const,
			checks: [
				{ check: "lint", argv: ["npm", "run", "lint"], cwd: ".", exitCode: 0, durationMs: 10, memo: false, outputTail: "" },
			],
		},
	};
	// One assurance, read by every consumer (DESIGN 4.8).
	const assurance = receiptAssurance(draft);
	strictEqual(assurance, "compromised");
	strictEqual(trustVerdict(settledRunTrust(draft)), assurance);
	match(
		mergeWithheldDetail({ assurance, contract, output, branch: INPUT.branch }) ?? "",
		/^merge withheld: the worker's own report lists a failing validation \(npm test\)/u,
	);
	strictEqual(await mapExitCode({ exitCode: 0, verdict: { assurance } } as unknown as RunResult), 1);
	const { ask, asked } = scripted([pick("Keep branch")]);
	await askMergeCard({ ask }, { ...INPUT, workerFailedChecks: ["npm test"], hostVerification: draft.hostVerification });
	match(asked[0]?.question ?? "", /Worker-reported check 'npm test'/u);
});
