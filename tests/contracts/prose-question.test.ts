import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import {
	createProseQuestionRegistration,
	PLAN_APPROVAL_CONTINUATION_MESSAGE,
	PROSE_QUESTION_CONTINUATION_MESSAGE,
} from "../../src/domains/middleware/prose-question.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function check(request: string, answer: string) {
	const registration = createProseQuestionRegistration({ askUserAvailable: () => true });
	registration.evaluate({ hook: "turn_start", text: request });
	return registration.evaluate({ hook: "turn_end", text: answer, metadata: { stopReason: "stop" } });
}

const STALLED_REPLY = "Running the benchmark now.";
const PLAN_TEXT = `${"Step: extend the list filter and cover its boundary. ".repeat(10)}Dispatched the coder with the approved plan.`;

describe("operator questions at turn close", () => {
	it("continues a real closing question and an offered choice", () => {
		deepStrictEqual(check("inspect this", "I found two choices. Which one should I use?"), [
			{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE },
		]);
		deepStrictEqual(check("inspect this", "I can fix it now. Let me know when you're ready."), [
			{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE },
		]);
		deepStrictEqual(check("why is CI red?", "If you can paste the failing CI job name, I can investigate it."), [
			{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE },
		]);
		deepStrictEqual(check("inspect this", "If you want, I can run the local checks and compare them."), [
			{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE },
		]);
		deepStrictEqual(check("inspect this", "If you want the full log, it is in tmp/run.log."), []);
	});

	it("leaves greetings alone but treats an acknowledgement-led instruction as a task", () => {
		deepStrictEqual(check("sup fool", "Hey. What are we working on?"), []);
		deepStrictEqual(check("ok proceed", "Done. Want me to run the tests too?"), [
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

	it("asks approval for a plan written as a terminal artifact", () => {
		const registration = createProseQuestionRegistration({ askUserAvailable: () => true });
		registration.evaluate({ hook: "turn_start", text: "plan how to add a filter" });
		registration.evaluate({
			hook: "after_tool",
			toolName: ToolNames.Artifact,
			toolArgs: { kind: "plan" },
			metadata: { resultKind: "ok" },
		});
		// A terminal tool closes the run with no assistant text and a normal stop.
		deepStrictEqual(registration.evaluate({ hook: "turn_end", text: "", metadata: { stopReason: "stop" } }), [
			{ kind: "request_continuation", message: PLAN_APPROVAL_CONTINUATION_MESSAGE },
		]);
	});
});

/**
 * The registration's lifecycle through the real chat loop: one turn_start and
 * turn_end per operator submission, ask_user answered inside the run (the
 * registry fires its after_tool through the same middleware contract), and
 * the loop's single continuation per operator prompt.
 */
describe("operator questions through the chat loop", () => {
	it("checks each operator turn once, after its interviews, and never a continuation", async () => {
		const scratch = await isolateClioEnv("clio-coder-prose-question-");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.prewarm = false;
		const context = dispatchStubContext({ settings });
		const target = settings.targets[0];
		ok(target);
		settings.chat.target = target.id;
		settings.chat.model = target.defaultModel ?? "gpt-4o";
		const middleware = createMiddlewareBundle().contract;
		// Each model run: whether it interviews the operator, then its closing text.
		const script: Array<{ asks?: true; reply: string }> = [
			{ asks: true, reply: "Applied the fix you picked." },
			{ reply: "Anytime. Want me to run the parser tests?" },
			{ asks: true, reply: "Fixed the lexer as you chose. Want me to run its tests too?" },
			{ reply: "Should I run the lexer tests?" },
			{ asks: true, reply: PLAN_TEXT },
			{ reply: STALLED_REPLY },
			{ reply: "Would you like me to run a different benchmark?" },
		];
		const prompts: string[] = [];
		const footers: string[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
			knownTargets: () => new Set([target.id]),
			middleware,
			createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
				let listener: (event: AgentEvent) => unknown = () => {};
				const state = { ...options?.initialState, messages: [] as AgentMessage[] };
				return {
					requestCorrelationId: () => undefined,
					agent: {
						state,
						subscribe: (next: typeof listener) => {
							listener = next;
							return () => {};
						},
						abort() {},
						async prompt(text: string) {
							const step = script[prompts.length];
							prompts.push(text);
							ok(step, `unexpected model run ${prompts.length}: ${text}`);
							await listener({ type: "agent_start" });
							if (step.asks)
								middleware.runHook({ hook: "after_tool", toolName: ToolNames.AskUser, metadata: { resultKind: "ok" } });
							const message = {
								role: "assistant",
								content: [{ type: "text", text: step.reply }],
								stopReason: "stop",
								timestamp: Date.now(),
							} as AgentMessage;
							state.messages.push(message);
							await listener({ type: "message_end", message });
							await listener({ type: "agent_end", messages: [message] });
						},
					},
				};
			}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
		});
		// Another continuation producer, standing in for the stalled-turn nudge.
		middleware.registerHook({
			id: "fixture.stalled",
			description: "continue a turn that announced work without doing it",
			hooks: ["turn_end"],
			evaluate: (input) =>
				input.text === STALLED_REPLY ? [{ kind: "request_continuation", message: "Run the benchmark now." }] : [],
		});
		middleware.registerHook(
			createProseQuestionRegistration({
				getTurnConstraints: () => loop.currentTurnConstraints?.(),
				askUserAvailable: () => true,
			}),
		);
		const unsubscribe = loop.onEvent((event) => {
			if (event.type === "notice" && event.surface === "footer" && event.key) footers.push(event.key);
		});
		try {
			// A reply without a question after an answered interview needs nothing.
			await loop.submit("check the parser and pick the fix");
			// The interview does not carry into the next operator turn.
			await loop.submit("thanks");
			strictEqual(prompts.length, 2);
			// An interview earlier in the run does not cover the closing question.
			// The one continuation is not itself checked.
			await loop.submit("look at the lexer and fix what is broken");
			strictEqual(prompts.length, 4);
			ok(prompts[3]?.includes(PROSE_QUESTION_CONTINUATION_MESSAGE));
			// A plan the operator approved through ask_user needs no second go-ahead.
			await loop.submit("plan how to add a --since filter to evidence list");
			strictEqual(prompts.length, 5);
			// Another producer's continuation spends the prompt's one nudge; its
			// closing question is not checked against the spent cap.
			await loop.submit("run the context benchmark and report its p50");
			strictEqual(prompts.length, 7);
			strictEqual(prompts.filter((text) => text.includes(PROSE_QUESTION_CONTINUATION_MESSAGE)).length, 1);
			ok(!prompts.some((text) => text.includes(PLAN_APPROVAL_CONTINUATION_MESSAGE)));
			deepStrictEqual(
				footers.filter((key) => key.startsWith("nudge.continuation")),
				["nudge.continuation.sent", "nudge.continuation.sent"],
			);
		} finally {
			unsubscribe();
			loop.dispose();
			await loop.whenSettled();
			scratch.restore();
		}
	});
});
