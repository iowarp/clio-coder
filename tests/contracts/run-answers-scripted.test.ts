import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import {
	loadScriptedAnswers,
	type ScriptedAnswers,
	UNSCRIPTED_EXIT_CODE,
	unscriptedRunMessage,
} from "../../src/cli/run-answers.js";
import type { Interview, InterviewAnswer } from "../../src/domains/extensions/public-api-v2.js";
import { createDecisionBoardStore } from "../../src/domains/session/decision-board.js";
import { isDecisionRecord } from "../../src/domains/session/entries.js";
import { createAskUserTool } from "../../src/tools/ask-user.js";
import { runParkedInterview } from "../../src/tools/extension-interview.js";
import type { AskUserToolPolicy } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const ANSWERS = `answers:
  - id: plan-introduction
    choice: Approve this plan as shown
  - header: Which config?
    choice: Project file
    note: keep the user file as it is
  - match: "^Carry out this plan"
    choice: Proceed
  - header: Research question
    note: Does tiered caching cut tail latency?
`;

function scripted(dir: string, text = ANSWERS): ScriptedAnswers {
	const file = path.join(dir, "answers.yaml");
	writeFileSync(file, text);
	const loaded = loadScriptedAnswers(file);
	if ("error" in loaded) throw new Error(loaded.error);
	return loaded;
}

function gate(checkpoint: string, label: string): Interview {
	return {
		id: "gate",
		title: "Gates",
		step: {
			key: "gate.one",
			questions: [
				{
					id: "choice",
					label,
					kind: "single",
					checkpoint,
					options: [
						{ value: "approve", label: "Approve this plan as shown" },
						{ value: "keep", label: "Keep it pending" },
					],
				},
			],
		},
	};
}

function policy(): AskUserToolPolicy {
	const now = new Date().toISOString();
	return {
		id: "interview-1",
		status: "idle",
		startedAt: now,
		updatedAt: now,
		sessionId: "session-1",
		turnId: "turn-1",
		rounds: [],
		decisions: [],
		inFlight: false,
		cancelled: false,
		answerCount: 0,
		callCount: 0,
		maxCalls: 6,
		askedQuestionKeys: new Set(),
	};
}

test("an answers file answers the author's questions only, and the record says scripted", async (t) => {
	const env = await isolateClioEnv("clio-coder-run-answers-");
	t.after(() => env.restore());
	const answers = scripted(env.dir);
	const file = path.join(env.dir, "answers.yaml");

	// An extension gate interview, answered by its checkpoint id.
	const heard: InterviewAnswer[] = [];
	const parked = await runParkedInterview(
		{ ask: answers.interview },
		gate("plan-introduction", "Approve the introduction plan?"),
		{ extensionId: "desk", title: "Desk" },
		async (answer) => {
			heard.push(answer);
			return { done: true, text: "sealed" };
		},
	);
	strictEqual(parked.outcome, "done");
	deepStrictEqual(heard[0]?.answers, { choice: "approve" });
	const rule = 'answers[0] id "plan-introduction"';
	deepStrictEqual(heard[0]?.scripted, { file, rules: { choice: rule } });
	deepStrictEqual(parked.scripted, { "gate.one": { file, rules: { choice: rule } } });

	// The model's ordinary ask_user round is not the author's: a matching header or regex rule does not answer it.
	// The call is refused as having no operator, records no round, and leaves the run going.
	const turnPolicy = policy();
	const ask = createAskUserTool({ askUser: answers.askUser });
	const ordinary = await ask.run(
		{
			action: "ask",
			questions: [
				{
					question: "Which config should the cleanup change?",
					header: "Which config?",
					options: [{ label: "User file" }, { label: "Project file" }],
				},
				{ question: "Carry out this plan?", header: "Plan", options: [{ label: "Proceed" }, { label: "Revise" }] },
			],
		},
		{ sessionId: "session-1", turnId: "turn-1", askUserPolicy: turnPolicy },
	);
	ok(ordinary.kind === "error");
	match(ordinary.message, /no operator to answer questions/u);
	strictEqual(turnPolicy.status, "idle");
	strictEqual(turnPolicy.rounds.length, 0);
	strictEqual(answers.unscripted(), null);

	// An operator_only question is the author's own, answered by its header and recorded as scripted.
	const operatorOnly = await ask.run(
		{
			action: "ask",
			questions: [
				{ question: "What is the paper's research question?", header: "Research question", operator_only: true },
			],
		},
		{ sessionId: "session-1", turnId: "turn-1", askUserPolicy: turnPolicy },
	);
	strictEqual(operatorOnly.kind, "ok");
	const roundAnswers = turnPolicy.rounds[0]?.answers ?? [];
	deepStrictEqual(
		roundAnswers.map((answer) => [answer.answer, answer.scripted?.rule, answer.auto]),
		[["Does tiered caching cut tail latency?", 'answers[3] header "Research question"', undefined]],
	);
	const entries: unknown[] = [];
	const board = createDecisionBoardStore({ appendEntry: (entry) => entries.push(entry) });
	turnPolicy.status = "complete";
	ok(board.recordFinalizedInterview(turnPolicy));
	const decisions = (entries[0] as { decisions: unknown[] }).decisions;
	ok(decisions.every(isDecisionRecord));
	deepStrictEqual(
		decisions.map((decision) => {
			const { scripted, operator_choice } = decision as { scripted?: unknown; operator_choice?: unknown };
			return [scripted, operator_choice];
		}),
		[[{ file, rule: 'answers[3] header "Research question"' }, true]],
	);
	strictEqual(answers.unscripted(), null);
});

test("an unscripted question cancels with reason unscripted and ends the run with exit 5", async (t) => {
	const env = await isolateClioEnv("clio-coder-run-answers-");
	t.after(() => env.restore());
	const answers = scripted(env.dir);
	const told: string[] = [];
	answers.onUnscripted((question) => told.push(question.checkpoint ?? ""));

	// The extension hears its step cancelled as unscripted; nothing is chosen for the author.
	const heard: InterviewAnswer[] = [];
	const parked = await runParkedInterview(
		{ ask: answers.interview },
		gate("results-acceptance", "Accept the results section?"),
		{ extensionId: "desk", title: "Desk" },
		async (answer) => {
			heard.push(answer);
			return { done: true, text: "kept pending" };
		},
	);
	strictEqual(parked.outcome, "cancelled");
	strictEqual(parked.reason, "unscripted");
	deepStrictEqual(heard, [{ id: "gate", step: "gate.one", answers: {}, nav: "cancel", reason: "unscripted" }]);
	deepStrictEqual(told, ["results-acceptance"]);
	const question = answers.unscripted();
	ok(question !== null);
	match(
		unscriptedRunMessage(answers, question),
		/unscripted question \(header "Accept the results section\?", id "results-acceptance"\)/u,
	);
	match(unscriptedRunMessage(answers, question), /answers\.yaml and run again$/u);

	// A later operator_only round is cancelled as unscripted too, and ends the turn.
	const result = await createAskUserTool({ askUser: answers.askUser }).run(
		{
			action: "ask",
			questions: [{ question: "Carry out this plan?", options: [{ label: "Proceed" }], operator_only: true }],
		},
		{ sessionId: "session-1", turnId: "turn-1", askUserPolicy: policy() },
	);
	ok(result.kind === "ok" && result.terminate === true);
	match(result.output, /^ask_user result: unscripted/u);

	// The headless run stops the turn at the tool boundary and fails with exit 5, outcome detail unscripted.
	const fresh = scripted(env.dir);
	const cancels: unknown[] = [];
	let handler: (event: unknown) => void = () => {};
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		cancel: (options: unknown) => {
			cancels.push(options);
			// The chat loop reports the cancel reason as a transcript notice, as a live run does.
			const reason = (options as { reason?: string }).reason ?? "";
			handler({ type: "notice", surface: "transcript", text: reason });
		},
		submit: async () => {
			handler({ type: "agent_start" });
			await fresh.interview([{ question: "Ship it?", header: "Release" }]);
			handler({ type: "agent_end", messages: [] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const stderr: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	const code = await runHeadlessMainAgent(chat as never, {
		prompt: "x",
		mode: "text",
		answers: fresh,
		shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
	});
	strictEqual(code, UNSCRIPTED_EXIT_CODE);
	strictEqual(cancels.length, 1);
	strictEqual((cancels[0] as { atToolBoundary?: boolean }).atToolBoundary, true);
	// The unscripted question is told once, with one prefix.
	const lines = stderr.join("").split("\n");
	strictEqual(lines.filter((line) => line.includes("unscripted question")).length, 1, lines.join("\n"));
	strictEqual(
		lines.some((line) => line.startsWith("clio-coder run: clio-coder run:")),
		false,
		lines.join("\n"),
	);
});

test("a bad answers file names the file and the offending entry", async (t) => {
	const env = await isolateClioEnv("clio-coder-run-answers-");
	t.after(() => env.restore());
	const file = path.join(env.dir, "answers.yaml");
	const cases: Array<[string, RegExp]> = [
		[
			"answers:\n  - header: A\n    choice: B\n  - id: x\n    header: y\n    choice: z\n",
			/answers\[1\]: needs exactly one of id, header or match/u,
		],
		["answers:\n  - match: '('\n    choice: B\n", /answers\[0\]\.match: invalid regular expression/u],
		["answers:\n  - header: A\n", /answers\[0\]: needs a choice, a note, or both/u],
		["answers:\n  - header: A\n    pick: B\n", /answers\[0\]\.pick: unknown key/u],
		["answer: []\n", /answer: unknown key/u],
	];
	for (const [text, expected] of cases) {
		writeFileSync(file, text);
		const loaded = loadScriptedAnswers(file);
		ok("error" in loaded, text);
		match(loaded.error, new RegExp(`^--answers ${file.replaceAll(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}: `, "u"));
		match(loaded.error, expected);
	}
	const missing = loadScriptedAnswers(path.join(env.dir, "absent.yaml"));
	ok("error" in missing && /cannot read the file/u.test(missing.error));
});
