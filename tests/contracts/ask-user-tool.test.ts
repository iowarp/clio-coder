import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Value } from "typebox/value";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { skillInstallOfferTag } from "../../src/core/skill-activation.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import {
	AWAY_ASK_WINDOW_MS,
	askUserWindowMs,
	YOLO_ASK_WINDOW_FLOOR_SECONDS,
} from "../../src/domains/safety/unattended.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createAskUserToolPolicy } from "../../src/session-control/chat-loop-messages.js";
import {
	type AskUserQuestion,
	type AskUserResult,
	askUserParameters,
	closeAskUserInterviewOnAssistantTurn,
	createAskUserTool,
	UNATTENDED_ESCAPE_ANSWER,
	UNATTENDED_FREE_TEXT_ANSWER,
	UNATTENDED_OUTWARD_ANSWER,
} from "../../src/tools/ask-user.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { type AskUserToolPolicy, createRegistry, prepareToolArgs, type ToolResult } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * ask_user through the session registry with the interview policy the chat
 * loop creates for a turn. The operator is the only stand-in: a handler that
 * records each round it was shown and answers from a script.
 */

type Reply = AskUserResult | ((questions: ReadonlyArray<AskUserQuestion>) => Promise<AskUserResult>);

function fixture(replies: Reply[], autonomy: AutonomyLevel = "default", live = false, admission?: AutonomyLevel) {
	const shown: Array<ReadonlyArray<AskUserQuestion>> = [];
	const presentations: unknown[] = [];
	const fallbacks: unknown[] = [];
	const registry = createRegistry({ safety: createWorkerSafety(), autonomy: () => autonomy });
	registerAllTools(registry, {
		mcpCapabilities: false,
		// The session wires the live autonomy into the tool; `live` does the same here.
		...(live ? { getAutonomy: () => autonomy } : {}),
		...(admission !== undefined ? { getAdmissionAutonomy: () => admission } : {}),
		askUser: async (questions, options) => {
			shown.push(questions);
			presentations.push(options?.decisionPresentation);
			fallbacks.push(options?.unattendedFallback);
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
		fallbacks,
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

	it("carries Proceed consent into implementation guidance without authorizing a revision or qualified answer", async () => {
		const question = "Carry out this plan?";
		for (const choice of ["Proceed with this plan (Recommended)", "Revise the plan first"]) {
			for (const value of [undefined, "Keep this plan-only for now"]) {
				const f = fixture([{ answers: [{ question, answer: choice, options: [choice], ...(value ? { value } : {}) }] }]);
				const answered = await f.call({ questions: [{ question, options: [{ label: choice }] }] });
				const completed = await f.call({ action: "complete", summary: "Plan reviewed" });
				for (const result of [answered, completed]) {
					if (result.kind !== "ok") throw new Error("expected ok");
					strictEqual(
						result.output.includes("then implement in this same turn"),
						choice.startsWith("Proceed") && value === undefined,
					);
					strictEqual(result.terminate, undefined);
				}
			}
		}
	});

	it("puts keeping a plan-only request first even when the model recommends implementation", async () => {
		const f = fixture([
			async (questions) => ({
				answers: [
					{
						question: questions[0]?.question ?? "missing question",
						answer: "Keep the plan (Recommended)",
						options: ["Keep the plan (Recommended)"],
					},
				],
			}),
		]);
		f.policy.planOnly = true;
		const result = await f.call({
			questions: [
				{
					question: "Carry out this plan?",
					options: [{ label: "Proceed as planned (Recommended)" }, { label: "Revise the plan first" }],
				},
			],
		});
		deepStrictEqual(
			f.shown[0]?.[0]?.options?.map((option) => option.label),
			["Keep the plan (Recommended)", "Proceed as planned", "Revise the plan first"],
		);
		ok(result.kind === "ok" && !result.output.includes("then implement in this same turn"));
		ok(result.kind === "ok" && result.output.startsWith("ask_user result: complete\n"));
	});

	it("shows the next ask after a sent-back or proceeding plan card, and not after a kept one", async () => {
		const card = (answer: string) => ({ answers: [{ question: "Carry out this plan?", answer, options: [answer] }] });
		const asked = { questions: [{ question: "Carry out this plan?", options: [{ label: "Revise the plan first" }] }] };
		const revised = { questions: [{ question: "Carry out the revised plan?", options: [{ label: "Keep the plan" }] }] };
		const sentBack = fixture([card("Revise the plan first"), card("Keep the plan")]);
		await sentBack.call(asked);
		await sentBack.call({ action: "complete", summary: "Revising" });
		const shown = await sentBack.call(revised);
		ok(shown.kind === "ok" && shown.output.startsWith("ask_user result: standalone_answered\n"));
		const proceeding = fixture([
			card("Proceed"),
			{ answers: [{ question: "Which heading?", answer: "Top", options: ["Top"] }] },
		]);
		await proceeding.call(asked);
		const later = await proceeding.call({ questions: [{ question: "Which heading?", options: [{ label: "Top" }] }] });
		ok(later.kind === "ok" && later.output.startsWith("ask_user result: standalone_answered\n"));
		const kept = fixture([card("Keep the plan")]);
		await kept.call(asked);
		const again = await kept.call(revised);
		ok(again.kind === "ok" && again.output.startsWith("ask_user result: already_complete\n"));
	});

	it("hides the install-offer binding tag from the surface and keeps it in the answer", async () => {
		const tag = skillInstallOfferTag("offer-1");
		const asked = {
			question: `Install worktree-create? ${tag}`,
			header: "Install skill",
			options: [{ label: "Not now" }],
		};
		const f = fixture([{ answers: [{ question: "Install worktree-create?", answer: "Not now", options: ["Not now"] }] }]);
		const answered = await f.call({ mode: "single_question", questions: [asked] });
		strictEqual(f.shown[0]?.[0]?.question, "Install worktree-create?");
		if (answered.kind !== "ok") throw new Error("expected ok");
		const answers = answered.details?.answers as Array<{ question: string }>;
		strictEqual(answers[0]?.question, asked.question);
	});

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
		if (completed.kind === "ok") {
			match(completed.output, /Act on the answers now: approval means do the work/);
			match(completed.output, /declines or says the work is enough, end in one sentence without restating earlier output/);
			match(completed.output, /End with the result, without a new question or offer/);
		}
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

	it("ends the turn on a cancel and never reads the dismissal as approval", async () => {
		const f = fixture([{ answers: [], cancelled: true }], "yolo");
		const first = await f.call({ questions: [{ question: "Which part of the config?" }] });
		strictEqual(first.kind === "ok" ? first.terminate : undefined, true);
		const text = first.kind === "ok" ? first.output : "";
		match(text, /not approval/);
		ok(!/proceed with defaults/i.test(text), "the cancel text must not tell the model to go ahead");
		const again = await f.call({ questions: [{ question: "Refactor it anyway?" }] });
		strictEqual(interviewOf(again).event, "already_cancelled");
		strictEqual(again.kind === "ok" ? again.terminate : undefined, true);
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

	// CLI-P39: a bare-string question cost a round on "questions.0: expected object, got string".
	it("asks a bare-string question as { question } before schema validation, with the schema unchanged", async () => {
		const raw = { questions: ["Which cache key?", { question: "Anything else?" }] };
		ok(!Value.Check(askUserParameters, raw), "the attached schema still refuses the raw shape");
		const prepared = prepareToolArgs(createAskUserTool(), raw);
		ok(Value.Check(askUserParameters, prepared), JSON.stringify(prepared));
		const f = fixture([{ answers: [{ question: "Which cache key?", answer: "Node id" }] }]);
		strictEqual((await f.call(raw)).kind, "ok");
		deepStrictEqual(f.shown, [[{ question: "Which cache key?" }, { question: "Anything else?" }]]);
	});

	it("answers a round nobody answered with its recommended options, closes the interview, and says so", async () => {
		const f = fixture([{ answers: [], timedOut: { afterSeconds: 300 } }]);
		const result = await f.call({ questions: [CACHE_QUESTION, { question: "Anything to add?" }] });
		strictEqual(f.fallbacks[0], true, "the tool lets the surface resolve its own rounds");
		const interview = interviewOf(result);
		strictEqual(interview.event, "round_auto_resolved");
		strictEqual(interview.status, "complete");
		deepStrictEqual(interview.latest_answers, [
			{ question: CACHE_QUESTION.question, answer: "Capability tuple", options: ["Capability tuple"], auto: true },
			{ question: "Anything to add?", answer: UNATTENDED_FREE_TEXT_ANSWER, auto: true },
		]);
		if (result.kind !== "ok") throw new Error("expected ok");
		strictEqual(result.terminate, undefined, "the turn continues");
		deepStrictEqual(result.details?.unattended, { afterSeconds: 300, autoResolved: 2 });
		match(result.output, /did not answer within 300 s/);
		match(result.output, /How should the cache be keyed\? -> Capability tuple/);
		match(result.output, /state each assumption in your final reply/);
		const decision = (interview.decisions as Array<Record<string, unknown>>)[0];
		strictEqual(decision?.source, "agent", "the board records Clio's choice as Clio's");
		deepStrictEqual(decision?.alternatives, ["Node id"]);
	});

	it("declines, not picks, a recommended option that leaves the workspace when nobody answers (bt-21)", async () => {
		const f = fixture([{ answers: [], timedOut: { afterSeconds: 300 } }]);
		const question = "Append the line to ~/notes.txt?";
		const result = await f.call({
			questions: [{ question, options: [{ label: "Append outside workspace (Recommended)" }, { label: "Skip it" }] }],
		});
		deepStrictEqual(interviewOf(result).latest_answers, [{ question, answer: UNATTENDED_ESCAPE_ANSWER, auto: true }]);
		if (result.kind !== "ok") throw new Error("expected ok");
		match(result.output, /leaves the workspace was declined, not picked: do not take that step/);
	});

	it("declines a plain yes when the question names a write outside the workspace (bt-21, drv-p2i)", async () => {
		const f = fixture([{ answers: [], timedOut: { afterSeconds: 60 } }]);
		const question =
			"The command `touch ../outside-p2i.txt` writes to a path outside the workspace root (/tmp/proj). It would create /tmp/outside-p2i.txt. Run it?";
		const result = await f.call({
			questions: [
				{
					question,
					options: [
						{
							label: "Yes, run it · recommended",
							description: "Run the touch command once; it creates an empty file one level above the workspace.",
						},
						{ label: "No, skip it" },
						{ label: "Run it from my terminal instead" },
					],
				},
			],
		});
		deepStrictEqual(interviewOf(result).latest_answers, [{ question, answer: UNATTENDED_ESCAPE_ANSWER, auto: true }]);
	});

	it("still picks a recommended option that keeps the step inside the workspace (bt-21)", async () => {
		const f = fixture([{ answers: [], timedOut: { afterSeconds: 60 } }]);
		const question = "The command writes to a path outside the workspace root. Run it?";
		const result = await f.call({
			questions: [
				{
					question,
					header: "Outside write",
					options: [{ label: "No, keep it inside (Recommended)" }, { label: "Yes, run it" }],
				},
			],
		});
		deepStrictEqual(interviewOf(result).latest_answers, [
			{
				question,
				answer: "No, keep it inside (Recommended)",
				options: ["No, keep it inside (Recommended)"],
				auto: true,
			},
		]);
	});

	it("ends the turn unapproved on a plan card asked after Clio answered for an absent operator", async () => {
		const f = fixture([{ answers: [], timedOut: { afterSeconds: 300 } }]);
		await f.call({ questions: [CACHE_QUESTION] });
		const result = await f.call({
			questions: [{ question: "Carry out this plan?", options: [{ label: "Yes, proceed (Recommended)" }] }],
		});
		strictEqual(f.shown.length, 1, "the plan card waits for the operator's next message");
		if (result.kind !== "ok") throw new Error("expected ok");
		ok(result.output.startsWith("ask_user result: plan_not_approved\n"), result.output);
		ok(!result.output.includes("approval means do the work"), result.output);
		strictEqual(result.terminate, true);
	});

	// Yolo drops approval cards, not the operator: a round reaches the surface at every level.
	it("asks the operator at yolo, of either confinement, and records their answer as theirs", async () => {
		for (const admission of ["yolo", "default"] as const) {
			const f = fixture(
				[{ answers: [{ question: CACHE_QUESTION.question, answer: "Node id", options: ["Node id"] }] }],
				"yolo",
				true,
				admission,
			);
			const result = await f.call({ questions: [CACHE_QUESTION] });
			strictEqual(f.shown.length, 1, `a ${admission} yolo round reaches the operator`);
			const interview = interviewOf(result);
			deepStrictEqual(interview.latest_answers, [
				{ question: CACHE_QUESTION.question, answer: "Node id", options: ["Node id"] },
			]);
			const decision = (interview.decisions as Array<Record<string, unknown>>)[0];
			strictEqual(decision?.value, "Node id", admission);
			strictEqual(decision?.source, undefined, "an operator's answer is not recorded as Clio's choice");
			if (result.kind !== "ok") throw new Error("expected ok");
			strictEqual(result.details?.unattended, undefined);
			ok(!/away by contract/u.test(result.output), result.output);
		}
	});

	it("runs a multi-round interview at yolo, such as plan-interview's, on the operator's answers", async () => {
		const f = fixture(
			[
				{ answers: [{ question: "Which scope?", answer: "Phase 1 only", options: ["Phase 1 only"] }] },
				{ answers: [{ question: "Carry out this plan?", answer: "Proceed", options: ["Proceed"] }] },
			],
			"yolo",
			true,
			"default",
		);
		const scope = { question: "Which scope?", options: [{ label: "Phase 1 only" }, { label: "Everything" }] };
		const close = {
			question: "Carry out this plan?",
			options: [{ label: "Proceed" }, { label: "Revise the plan first" }],
		};
		strictEqual(interviewOf(await f.call({ questions: [scope] })).event, "round_answered");
		strictEqual(interviewOf(await f.call({ questions: [close] })).event, "complete", "Proceed closes the plan");
		strictEqual(f.shown.length, 2);
	});

	it("at yolo takes the recommended option when the operator's window lapses, and an outward round is a no", async () => {
		const local = fixture([{ answers: [], timedOut: { afterSeconds: 300 } }], "yolo", true, "default");
		const result = await local.call({ questions: [CACHE_QUESTION] });
		strictEqual(local.shown.length, 1);
		deepStrictEqual(interviewOf(result).latest_answers, [
			{ question: CACHE_QUESTION.question, answer: "Capability tuple", options: ["Capability tuple"], auto: true },
		]);
		strictEqual(result.kind === "ok" ? result.terminate : undefined, undefined, "the turn continues");
		const outward = fixture([{ answers: [], timedOut: { afterSeconds: 300 } }], "yolo", true, "yolo");
		deepStrictEqual(
			interviewOf(await outward.call({ exposure: "outward", questions: [CACHE_QUESTION] })).latest_answers,
			[{ question: CACHE_QUESTION.question, answer: UNATTENDED_OUTWARD_ANSWER, auto: true }],
		);
	});

	it("answers an unanswered outward round no, whatever the model listed first", async () => {
		const f = fixture([{ answers: [], timedOut: { afterSeconds: 60 } }], "yolo");
		const result = await f.call({
			exposure: "outward",
			questions: [{ question: "Push the release?", options: [{ label: "Yes, push" }, { label: "No" }] }],
		});
		deepStrictEqual(interviewOf(result).latest_answers, [
			{ question: "Push the release?", answer: UNATTENDED_OUTWARD_ANSWER, auto: true },
		]);
	});

	it("records an outward round on the interview and keeps it outward after a later local round", async () => {
		const f = fixture(
			[
				{ answers: [{ question: "Open the PR?", answer: "yes" }] },
				{ answers: [{ question: "Draft title?", answer: "fine" }] },
			],
			"yolo",
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

	// The question is the operator's gate on an outward step; a permission card to ask it was a second dialog.
	it("shows an outward round with no approval card first, at default and contained yolo, and rejects a misspelled tier", async () => {
		for (const [autonomy, admission] of [
			["default", undefined],
			["yolo", "default"],
		] as const) {
			const f = fixture([{ answers: [{ question: "Publish the release?", answer: "No" }] }], autonomy, true, admission);
			const verdict = await f.invoke({ exposure: "outward", questions: [{ question: "Publish the release?" }] });
			strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
			strictEqual(f.shown.length, 1, autonomy);
		}
		const f = fixture([]);
		match(
			errorMessage(await f.call({ exposure: "public", questions: [{ question: "Publish the release?" }] })),
			/exposure must be local or outward/,
		);
		deepStrictEqual(f.shown, []);
	});

	it("never answers an operator_only choice for the operator, and only their answer carries operator_choice", async () => {
		const CHOICE = {
			question: "Which hypothesis should we pursue?",
			header: "Hypothesis choice",
			options: [{ label: "H1" }, { label: "H2" }],
			operator_only: true,
		};
		match(errorMessage(await fixture([]).call({ questions: [CHOICE, CACHE_QUESTION] })), /asked alone/);
		const unattended: Array<[Reply[], AutonomyLevel]> = [
			[[{ answers: [], timedOut: { afterSeconds: 300 } }], "default"],
			[[{ answers: [], timedOut: { afterSeconds: 300 } }], "yolo"],
		];
		for (const [replies, autonomy] of unattended) {
			const f = fixture(replies, autonomy, true);
			const result = await f.call({ questions: [CHOICE] });
			strictEqual(interviewOf(result).event, "operator_choice_unanswered", autonomy);
			deepStrictEqual(interviewOf(result).decisions, [], autonomy);
			strictEqual(result.kind === "ok" ? result.terminate : undefined, true, autonomy);
			strictEqual(f.shown.length, 1, autonomy);
		}
		const f = fixture([{ answers: [{ question: CHOICE.question, answer: "H2", options: ["H2"] }] }]);
		await f.call({ questions: [CHOICE] });
		await f.call({ action: "complete", decisions: [{ key: "hypothesis_choice", value: "H1" }] });
		deepStrictEqual(
			f.policy.decisions.map(({ key, value, operator_choice }) => ({ key, value, operator_choice })),
			[{ key: "hypothesis_choice", value: "H2", operator_choice: true }],
		);
	});

	it("closes an answered interview implicitly on the next non-ask_user assistant turn without asking for action=complete (XR-5)", async () => {
		const f = fixture([
			{
				answers: [
					{
						question: CACHE_QUESTION.question,
						answer: "Capability tuple",
						options: ["Capability tuple"],
					},
				],
			},
		]);
		const answered = await f.call({ questions: [CACHE_QUESTION] });
		if (answered.kind !== "ok") throw new Error("expected ok");
		const interview = interviewOf(answered);
		strictEqual(interview.event, "round_answered");
		strictEqual(interview.status, "active");
		ok(!/action=complete/i.test(answered.output), answered.output);
		ok(!/modal remains open/i.test(answered.output), answered.output);
		ok(!/action=complete/i.test(String(interview.next ?? "")), String(interview.next));

		// Assistant messages that call ask_user (direct, gateway call, gateway chain) or fail keep the interview open.
		const keepOpen: Array<{ role: "assistant"; content: unknown[]; stopReason: string }> = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: ToolNames.AskUser, arguments: {} }],
				stopReason: "toolUse",
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", name: ToolNames.Gateway, arguments: { op: "call", capability: ToolNames.AskUser } }],
				stopReason: "toolUse",
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: ToolNames.Gateway,
						arguments: { op: "chain", steps: [{ id: "a", capability: ToolNames.AskUser, args: {} }] },
					},
				],
				stopReason: "toolUse",
			},
			{ role: "assistant", content: [{ type: "text", text: "error" }], stopReason: "error" },
			{ role: "assistant", content: [{ type: "text", text: "aborted" }], stopReason: "aborted" },
			{ role: "assistant", content: [{ type: "text", text: "cut off" }], stopReason: "length" },
		];
		for (const msg of keepOpen) {
			strictEqual(await closeAskUserInterviewOnAssistantTurn(f.policy, msg), false);
			strictEqual(f.policy.status, "active");
		}

		// The next settled assistant message with no ask_user call closes the interview with the derived decisions.
		const closed = await closeAskUserInterviewOnAssistantTurn(f.policy, {
			role: "assistant",
			content: [{ type: "text", text: "Using capability tuple for the cache key." }],
			stopReason: "stop",
		});
		strictEqual(closed, true);
		strictEqual(f.policy.status, "complete");
		strictEqual(f.policy.summary, undefined);
		ok(typeof f.policy.endedAt === "string");
		const transcript = JSON.parse(readFileSync(String(f.policy.transcriptPath), "utf8"));
		strictEqual(transcript.status, "complete");
		strictEqual(transcript.summary, undefined);
		deepStrictEqual(
			transcript.decisions.map((decision: { key: string; value: string }) => [decision.key, decision.value]),
			[["cache_key", "Capability tuple"]],
		);
		strictEqual(interviewOf(await f.call({ questions: [{ question: "Follow-up?" }] })).event, "already_complete");
	});

	it("closes the interview through the chat loop when the model answers without a complete call (XR-5)", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.prewarm = false;
		const context = dispatchStubContext({ settings });
		const target = settings.targets[0];
		ok(target);
		settings.chat.target = target.id;
		settings.chat.model = target.defaultModel ?? "gpt-4o";
		const registry = createRegistry({ safety: createWorkerSafety(), autonomy: () => "default" });
		registerAllTools(registry, {
			mcpCapabilities: false,
			askUser: async () => ({
				answers: [{ question: CACHE_QUESTION.question, answer: "Node id", options: ["Node id"] }],
			}),
		});
		const entries: SessionEntry[] = [];
		let leaf: string | null = null;
		const session = {
			current: () => ({ id: "xr5-session", cwd: scratch.dir, cwdHash: "xr5-repo" }),
			tree: () => ({ leafId: leaf }),
			leafId: () => leaf,
			append(turn: TurnInput) {
				const id = turn.id ?? `turn-${entries.length + 1}`;
				leaf = id;
				entries.push({
					kind: "message",
					turnId: id,
					parentTurnId: turn.parentId,
					timestamp: new Date().toISOString(),
					role: turn.kind,
					payload: turn.payload,
				} as SessionEntry);
				return { id };
			},
			appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
				const row = {
					...entry,
					turnId: `entry-${entries.length + 1}`,
					timestamp: new Date().toISOString(),
				} as SessionEntry;
				entries.push(row);
				return row;
			},
		} as unknown as SessionContract;
		let finalized: AskUserToolPolicy | undefined;
		const loop = createChatLoop({
			getSettings: () => settings,
			getAutonomy: () => "default",
			providers: context.getContract("providers") as ProvidersContract,
			knownTargets: () => new Set([target.id]),
			session,
			bus: context.bus,
			readSessionEntries: () => entries,
			toolRegistry: registry,
			onAskUserFinalized: (policy) => {
				finalized = policy;
			},
			createAgent: ((agentOptions: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
				let listener: (event: AgentEvent) => unknown = () => {};
				const state = { ...agentOptions?.initialState, messages: [] as AgentMessage[] };
				return {
					requestCorrelationId: () => undefined,
					agent: {
						state,
						subscribe: (fn: (event: AgentEvent) => unknown) => {
							listener = fn;
							return () => {};
						},
						async prompt() {
							await listener({ type: "agent_start" } as AgentEvent);
							const askTool = state.tools?.find((tool) => tool.name === ToolNames.AskUser);
							if (!askTool) throw new Error("ask_user tool missing from agent state");
							const askMsg = {
								role: "assistant",
								content: [
									{ type: "toolCall", id: "call-1", name: ToolNames.AskUser, arguments: { questions: [CACHE_QUESTION] } },
								],
								stopReason: "toolUse",
							} as unknown as AgentMessage;
							state.messages.push(askMsg);
							await listener({ type: "message_end", message: askMsg } as AgentEvent);
							const result = await askTool.execute("call-1", { questions: [CACHE_QUESTION] });
							await listener({
								type: "tool_execution_end",
								toolCallId: "call-1",
								toolName: ToolNames.AskUser,
								result,
								isError: false,
							} as unknown as AgentEvent);
							const replyMsg = {
								role: "assistant",
								content: [{ type: "text", text: "Keying the cache by node id." }],
								stopReason: "stop",
							} as unknown as AgentMessage;
							state.messages.push(replyMsg);
							await listener({ type: "message_end", message: replyMsg } as AgentEvent);
							await listener({ type: "agent_end", messages: [...state.messages] } as AgentEvent);
						},
						abort() {},
						followUp() {},
						steer() {},
						clearAllQueues() {},
						waitForIdle: async () => {},
					},
				};
			}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
		});
		try {
			await loop.submit("Design the cache key.");
		} finally {
			loop.dispose();
		}
		ok(finalized, "onAskUserFinalized ran");
		strictEqual(finalized.status, "complete");
		strictEqual(finalized.summary, undefined, "closed implicitly, not by turn_finished fallback");
		deepStrictEqual(
			finalized.decisions.map((decision) => [decision.key, decision.value]),
			[["cache_key", "Node id"]],
		);
		const transcript = JSON.parse(readFileSync(String(finalized.transcriptPath), "utf8"));
		strictEqual(transcript.status, "complete");
		strictEqual(transcript.summary, undefined);
	});
});

describe("ask_user: who answered, and how long a round waits", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-ask-user-answers-");
	});
	afterEach(() => scratch.restore());

	it("tells the main session only what the operator answered themselves", async () => {
		const seen: Array<ReadonlyArray<{ question: string; answer: string }>> = [];
		const registry = createRegistry({
			safety: createWorkerSafety(),
			autonomy: () => "default",
			onOperatorAnswered: (answers) => seen.push(answers),
		});
		const replies: AskUserResult[] = [
			{ answers: [{ question: "Push main?", answer: "Yes, push", options: ["Yes, push"] }] },
			{ answers: [], timedOut: { afterSeconds: 300 } },
		];
		registerAllTools(registry, {
			mcpCapabilities: false,
			askUser: async () => replies.shift() ?? { answers: [], cancelled: true },
		});
		const policy = createAskUserToolPolicy([{ name: ToolNames.AskUser }]);
		if (!policy) throw new Error("the chat loop creates no interview policy for ask_user");
		const call = (question: string) =>
			registry.invoke(
				{
					tool: ToolNames.AskUser,
					args: { questions: [{ question, options: [{ label: "Yes, push" }, { label: "No" }] }] },
				},
				{ askUserPolicy: policy, sessionId: "s", turnId: "t" },
			);
		await call("Push main?");
		await call("Tag the release?");
		deepStrictEqual(
			seen,
			[[{ question: "Push main?", answer: "Yes, push" }]],
			"Clio's pick for an absent operator is not theirs",
		);
	});

	it("bounds a yolo round's window, and shortens it once the operator was seen away", () => {
		strictEqual(askUserWindowMs(300, { yolo: false, away: false }), 300_000);
		strictEqual(askUserWindowMs(0, { yolo: false, away: false }), 0, "default honors wait-forever");
		strictEqual(askUserWindowMs(0, { yolo: true, away: false }), YOLO_ASK_WINDOW_FLOOR_SECONDS * 1000);
		strictEqual(askUserWindowMs(300, { yolo: true, away: true }), AWAY_ASK_WINDOW_MS);
		strictEqual(askUserWindowMs(10, { yolo: false, away: true }), 10_000);
		strictEqual(askUserWindowMs(0, { yolo: false, away: true }), 0);
		// F-C1: an operator_only question stays open past the unattended window at every autonomy level.
		for (const yolo of [false, true])
			for (const away of [false, true])
				strictEqual(askUserWindowMs(300, { yolo, away, operatorOnly: true }), 0, `yolo ${yolo}, away ${away}`);
	});
});
