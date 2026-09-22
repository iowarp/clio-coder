import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createAskUserToolPolicy } from "../../src/interactive/chat-loop-messages.js";
import type { AskUserQuestion, AskUserResult } from "../../src/tools/ask-user.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry, type ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * ask_user through the session registry with the interview policy the chat
 * loop creates for a turn. The operator is the only stand-in: a handler that
 * records each round it was shown and answers from a script.
 */

type Reply = AskUserResult | ((questions: ReadonlyArray<AskUserQuestion>) => Promise<AskUserResult>);

function fixture(replies: Reply[], autonomy: AutonomyLevel = "auto-edit") {
	const shown: Array<ReadonlyArray<AskUserQuestion>> = [];
	const presentations: unknown[] = [];
	const registry = createRegistry({ safety: createWorkerSafety(), autonomy: () => autonomy });
	registerAllTools(registry, {
		mcpCapabilities: false,
		askUser: async (questions, options) => {
			shown.push(questions);
			presentations.push(options?.decisionPresentation);
			const reply = replies.shift();
			if (reply === undefined) throw new Error("the operator was asked more rounds than the test scripted");
			return typeof reply === "function" ? reply(questions) : reply;
		},
	});
	const policy = createAskUserToolPolicy([{ name: ToolNames.AskUser }]);
	if (!policy) throw new Error("the chat loop creates no interview policy for ask_user");
	return {
		shown,
		presentations,
		policy,
		invoke(args: Record<string, unknown>) {
			return registry.invoke(
				{ tool: ToolNames.AskUser, args },
				{ askUserPolicy: policy, sessionId: "session-1", turnId: "turn-1" },
			);
		},
		async call(args: Record<string, unknown>): Promise<ToolResult> {
			const verdict = await this.invoke(args);
			if (verdict.kind !== "ok") throw new Error(`ask_user was not admitted: ${JSON.stringify(verdict)}`);
			return verdict.result;
		},
	};
}

function interviewOf(result: ToolResult): Record<string, unknown> {
	if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result.details?.interview as Record<string, unknown>;
}

function errorMessage(result: ToolResult): string {
	if (result.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(result)}`);
	return result.message;
}

const CACHE_QUESTION = {
	question: "How should the cache be keyed?",
	header: "Cache key",
	options: [{ label: "Capability tuple", description: "matches the buckets" }, { label: "Node id" }],
};

describe("ask_user tool", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-ask-user-tool-");
	});
	afterEach(() => scratch.restore());

	it("asks the operator, derives a decision from the answer, and persists the interview transcript", async () => {
		const f = fixture([
			{
				answers: [
					{
						question: CACHE_QUESTION.question,
						answer: "Capability tuple, plus a TTL",
						options: ["Capability tuple"],
						value: "plus a TTL",
					},
				],
			},
		]);
		const answered = await f.call({ questions: [CACHE_QUESTION], summary: "cache design" });
		const interview = interviewOf(answered);
		strictEqual(interview.event, "round_answered");
		strictEqual(interview.status, "active");
		strictEqual(interview.exposure, "local");
		deepStrictEqual(interview.decisions, [
			{
				key: "cache_key",
				value: "Capability tuple, plus a TTL",
				label: "Cache key",
				options: ["Capability tuple"],
				text: "plus a TTL",
				source_question: CACHE_QUESTION.question,
			},
		]);
		deepStrictEqual(f.shown, [[CACHE_QUESTION]]);
		ok(f.presentations[0] !== undefined, "the host receives the decision presentation for the round");

		const completed = await f.call({
			action: "complete",
			summary: "keyed by capability",
			decisions: [{ key: "Eviction Policy", value: "LRU" }],
		});
		strictEqual(interviewOf(completed).status, "complete");
		const transcript = JSON.parse(readFileSync(String(interviewOf(completed).transcript_path), "utf8"));
		strictEqual(transcript.schema, "clio-coder.ask_user.interview.v1");
		strictEqual(transcript.sessionId, "session-1");
		strictEqual(transcript.turnId, "turn-1");
		strictEqual(transcript.summary, "keyed by capability");
		deepStrictEqual(
			transcript.decisions.map((decision: { key: string; value: string }) => [decision.key, decision.value]),
			[
				["cache_key", "Capability tuple, plus a TTL"],
				["eviction_policy", "LRU"],
			],
		);
		strictEqual(transcript.rounds.length, 1);

		strictEqual(interviewOf(await f.call({ questions: [{ question: "Anything else?" }] })).event, "already_complete");
		strictEqual(f.shown.length, 1, "a closed interview never reaches the operator again");
	});

	it("ignores a repeated round, closes at the round limit, and stays closed after a cancel", async () => {
		const answer = (text: string): AskUserResult => ({ answers: [{ question: "q", answer: text }] });
		const limited = fixture([answer("first")]);
		strictEqual(interviewOf(await limited.call({ questions: [{ question: "First?" }], max_rounds: 1 })).rounds, 1);
		strictEqual(
			interviewOf(await limited.call({ questions: [{ question: " first? " }] })).event,
			"duplicate_round_ignored",
		);
		const closed = interviewOf(await limited.call({ questions: [{ question: "Second?" }] }));
		strictEqual(closed.event, "round_limit_reached");
		strictEqual(closed.status, "complete");
		strictEqual(limited.shown.length, 1);

		const cancelled = fixture([{ answers: [], cancelled: true }]);
		const first = await cancelled.call({ questions: [{ question: "Proceed?" }] });
		strictEqual(interviewOf(first).event, "cancelled");
		strictEqual(first.kind === "ok" ? first.details?.cancelled : undefined, true);
		strictEqual(interviewOf(await cancelled.call({ questions: [{ question: "Really?" }] })).event, "already_cancelled");
		strictEqual(cancelled.shown.length, 1);
	});

	it("refuses a second round while the operator is still answering the first", async () => {
		let release!: (result: AskUserResult) => void;
		const f = fixture([() => new Promise<AskUserResult>((resolve) => (release = resolve))]);
		const pending = f.call({ questions: [{ question: "Slow?" }] });
		await new Promise((resolve) => setImmediate(resolve));
		match(errorMessage(await f.call({ questions: [{ question: "Other?" }] })), /round is already in progress/);
		release({ answers: [{ question: "Slow?", answer: "yes" }] });
		strictEqual(interviewOf(await pending).event, "round_answered");
		strictEqual(f.shown.length, 1);
	});

	it("names the malformed field and never shows the operator an invalid round", async () => {
		const f = fixture([]);
		const five = Array.from({ length: 5 }, (_, index) => ({ question: `Q${index}?` }));
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ action: "maybe", questions: [{ question: "Q?" }] }, /action must be ask or complete/],
			[{}, /questions must be an array/],
			[{ questions: [] }, /questions must contain at least 1 item/],
			[{ questions: five }, /questions must contain at most 4 items/],
			[{ questions: [{ header: "no text" }] }, /questions\[0\]\.question is required/],
			[{ questions: [{ question: "Q?", options: [{ description: "no label" }] }] }, /options\[0\]\.label is required/],
			[{ mode: "single", questions: [{ question: "A?" }, { question: "B?" }] }, /mode=single_question carries exactly 1/],
			[{ mode: "batchwise", questions: [{ question: "Q?" }] }, /mode must be round or single_question/],
			[{ max_rounds: 0, questions: [{ question: "Q?" }] }, /max_rounds must be an integer from 1 to 24/],
			[{ action: "complete", questions: [{ question: "Q?" }] }, /action=complete must not include questions/],
			[{ action: "complete", decisions: [{ key: "k" }] }, /decisions\[0\]\.value is required/],
		];
		for (const [args, expected] of cases) {
			const message = errorMessage(await f.call(args));
			ok(message.startsWith("ask_user: "), message);
			match(message, expected, JSON.stringify(args));
		}
		deepStrictEqual(f.shown, []);
		strictEqual(f.policy.status, "idle");
	});

	it("records an outward round on the interview and keeps it outward after a later local round", async () => {
		const f = fixture(
			[
				{ answers: [{ question: "Open the PR?", answer: "yes" }] },
				{ answers: [{ question: "Draft title?", answer: "fine" }] },
			],
			"full-auto",
		);
		strictEqual(
			interviewOf(await f.call({ exposure: "outward", questions: [{ question: "Open the PR?" }] })).exposure,
			"outward",
		);
		strictEqual(interviewOf(await f.call({ questions: [{ question: "Draft title?" }] })).exposure, "outward");
		match(
			errorMessage(await f.call({ exposure: "public", questions: [{ question: "Q?" }] })),
			/exposure must be local or outward/,
		);
		strictEqual(f.shown.length, 2);
	});

	it("parks an outward or misspelled exposure for the operator at auto-edit instead of asking ungated", async () => {
		const f = fixture([]);
		for (const exposure of ["outward", "public"]) {
			const verdict = await f.invoke({ exposure, questions: [{ question: "Publish the release?" }] });
			strictEqual(verdict.kind, "blocked", JSON.stringify(verdict));
			strictEqual(verdict.kind === "blocked" ? verdict.deniedPark : undefined, true);
		}
		deepStrictEqual(f.shown, []);
		strictEqual(f.policy.status, "idle");
	});
});
