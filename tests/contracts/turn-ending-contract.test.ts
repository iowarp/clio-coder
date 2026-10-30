import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { isPlanOnlyRequest, stripPlanCloseOptions } from "../../src/core/plan-request.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { createPlanCloseRegistration } from "../../src/domains/middleware/plan-close.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("turn-ending contract in the session prompt", () => {
	const systemPrompt = (inputs: { headless?: boolean; operatorInterviews?: boolean }, safety = "safety.default") =>
		compile(loadFragments(), {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety,
			sessionInputs: {
				coordinatorCapabilities: [ToolNames.AskUser, ToolNames.Read],
				provider: "local",
				model: "stable-model",
				providerSupportsTools: true,
				toolNames: [ToolNames.AskUser, ToolNames.Read],
				...inputs,
			},
		}).systemPrompt;
	const identityHalf = "It ends a turn in one of two states.";

	it("teaches both states and the ask_user endings where an operator can answer", () => {
		const prompt = systemPrompt({ operatorInterviews: true });
		ok(prompt.includes("## Ending a turn"), prompt);
		ok(prompt.includes("Every turn ends in one of two states:"), prompt);
		ok(
			prompt.includes('A requested plan always ends with ask_user "Carry out this plan?", even with no question.'),
			prompt,
		);
		ok(prompt.includes("options carrying open choices: [Proceed with a per-user file (Recommended)"), prompt);
		ok(prompt.includes("An explicit, specific operator instruction is its own consent"), prompt);
		ok(prompt.includes(identityHalf), prompt);
	});

	// #421: yolo resolves ambiguity with a stated default and never parks a plan on an approval card.
	it("renders the assume-and-proceed variant under yolo", () => {
		const prompt = systemPrompt({ operatorInterviews: true }, "safety.yolo");
		ok(prompt.includes("## Ending a turn"), prompt);
		ok(prompt.includes("Under yolo every turn ends Done"), prompt);
		ok(prompt.includes("Take the recommended default, state the assumption in the final reply"), prompt);
		// #407: the operator is away by contract, so the variant never offers a question.
		ok(!prompt.includes("Reserve an ask_user call"), prompt);
		ok(!/## Ending a turn[\s\S]*ask_user/u.test(prompt), prompt);
		ok(!prompt.includes("Every turn ends in one of two states:"), prompt);
		ok(!prompt.includes('always ends with ask_user "Carry out this plan?"'), prompt);
	});

	it("keeps only the no-offer half in headless and ACP prompts", () => {
		for (const inputs of [{ headless: true, operatorInterviews: true }, {}]) {
			const prompt = systemPrompt(inputs);
			ok(!prompt.includes("## Ending a turn"), prompt);
			ok(!prompt.includes('ask_user "'), prompt);
			ok(prompt.includes(identityHalf), prompt);
			ok(prompt.includes("with no closing offer, courtesy question or menu of next steps"), prompt);
			// The greeting rule needs an operator to greet; headless runs leave it out.
			strictEqual(prompt.includes("stops\nthere, without a question"), inputs.headless !== true);
		}
	});
});

it("continues only an armed plan that has not asked or changed files, once", () => {
	let plan = false;
	let canAsk = true;
	const rule = createPlanCloseRegistration({ canAsk: () => canAsk, isPlan: () => plan });
	const start = (metadata: MiddlewareHookInput["metadata"] = {}) => rule.evaluate({ hook: "turn_start", metadata });
	const end = (stopReason = "stop") => rule.evaluate({ hook: "turn_end", metadata: { stopReason } });
	start();
	deepStrictEqual(end(), []);
	plan = true;
	start();
	const effects = end();
	strictEqual(effects.length, 1);
	strictEqual(effects[0]?.kind, "request_continuation");
	ok(effects[0]?.kind === "request_continuation" && effects[0].message.includes('ask_user "Carry out this plan?"'));
	deepStrictEqual(end(), []);
	start({ requestContinuation: true });
	deepStrictEqual(end(), []);
	for (const toolName of [ToolNames.Edit, ToolNames.Write]) {
		start();
		rule.evaluate({ hook: "after_tool", toolName });
		deepStrictEqual(end(), []);
	}
	start();
	rule.evaluate({
		hook: "after_tool",
		toolName: ToolNames.AskUser,
		toolArgs: { questions: [{ question: "Invalid input?" }] },
	});
	strictEqual(
		rule.evaluate({
			hook: "turn_end",
			text: "Plan: implement the parser, then validate it.",
			metadata: { stopReason: "stop" },
		}).length,
		1,
	);
	start();
	rule.evaluate({ hook: "after_tool", toolName: ToolNames.AskUser });
	deepStrictEqual(end(), []);
	start();
	rule.evaluate({
		hook: "after_tool",
		toolName: ToolNames.AskUser,
		toolArgs: { questions: [{ question: "Carry out this plan?" }] },
	});
	deepStrictEqual(rule.evaluate({ hook: "turn_end", text: "No files changed.", metadata: { stopReason: "stop" } }), []);
	start();
	rule.evaluate({ hook: "after_tool", toolName: ToolNames.Read });
	strictEqual(end().length, 1);
	for (const stopReason of ["error", "aborted", "length"]) {
		start();
		deepStrictEqual(end(stopReason), []);
	}
	canAsk = false;
	start();
	deepStrictEqual(end(), []);
	canAsk = true;
	plan = false;
	start({ turnMode: "proposal" });
	strictEqual(end().length, 1);
});

// #431: an expensive plan close belongs only to a current continuation of that task.
it("delivers a downgraded plan close once, only on a current same-session continuation", (t) => {
	let elapsed = 0;
	t.mock.method(performance, "now", () => elapsed);
	for (const scenario of [
		{ text: "continue", sessionId: "original", idleMs: 0, requestContinuation: false, expected: true },
		{ text: "", sessionId: "original", idleMs: 0, requestContinuation: true, expected: true },
		{ text: "Proceed please.", sessionId: "original", idleMs: 0, requestContinuation: false, expected: true },
		{ text: "go on", sessionId: "original", idleMs: 299_999, requestContinuation: false, expected: true },
		{ text: "Implement the cache", sessionId: "original", idleMs: 0, requestContinuation: false, expected: false },
		{ text: "continue", sessionId: "original", idleMs: 300_000, requestContinuation: false, expected: false },
		{ text: "", sessionId: "original", idleMs: 300_000, requestContinuation: true, expected: false },
		{ text: "continue", sessionId: "other", idleMs: 0, requestContinuation: false, expected: false },
	]) {
		elapsed = 1_000;
		const rule = createPlanCloseRegistration({ canAsk: () => true, isPlan: () => undefined });
		rule.evaluate({ hook: "turn_start", sessionId: "original", text: "Write a plan for adding a cache." });
		deepStrictEqual(
			rule.evaluate({ hook: "turn_end", sessionId: "original", metadata: { stopReason: "stop", contextTokens: 128_000 } }),
			[],
		);
		elapsed += scenario.idleMs;
		const effects = rule.evaluate({
			hook: "turn_start",
			sessionId: scenario.sessionId,
			text: scenario.text,
			metadata: { requestContinuation: scenario.requestContinuation },
		});
		strictEqual(effects.length, scenario.expected ? 1 : 0, JSON.stringify(scenario));
		if (scenario.expected) {
			const effect = effects[0];
			ok(effect?.kind === "inject_reminder" && effect.audience === "model");
			ok(effect.message.includes('ask_user "Carry out this plan?"'));
		}
		deepStrictEqual(rule.evaluate({ hook: "turn_end", metadata: { stopReason: "stop" } }), []);
		deepStrictEqual(rule.evaluate({ hook: "turn_start", sessionId: "original", text: "continue" }), []);
	}
});

// #431: a long pasted document that mentions planning is evidence, not a plan request.
it("does not arm on a long pasted document that mentions planning", () => {
	const rule = createPlanCloseRegistration({ canAsk: () => true, isPlan: () => undefined });
	const armed = (text: string) => {
		const effects = rule.evaluate({ hook: "turn_start", text, metadata: { promptChars: text.length } });
		rule.evaluate({ hook: "turn_end", metadata: { stopReason: "stop" } });
		return effects.length > 0;
	};
	const sections = ["Ingest", "Indexing", "Query", "Retention", "Rollout"].map(
		(area, index) =>
			`## ${index + 1}. ${area}\n\nThe ${area.toLowerCase()} tier was sized during capacity planning in Q2. ` +
			"The migration plan moves one shard group per night behind a feature flag, and each step has a rollback " +
			"plan that restores the previous manifest within ten minutes. Planning assumed 40% headroom on every node.\n\n" +
			"| Phase | Owner | Exit criterion |\n| --- | --- | --- |\n| Dry run | storage | p99 under 80 ms |\n" +
			"| Canary | sre | no paging alerts for 48 h |\n| General | storage | error budget above 90% |\n\n" +
			"- Risks: plans that span shard groups need a coordinator lock.\n- Open: who signs off the capacity plan?\n",
	);
	const doc = `# Storage migration design\n\n${sections.join("\n").repeat(3)}`;
	ok(doc.length > 8_000, String(doc.length));
	strictEqual(armed(`Summarize the risks in this design doc in five bullets.\n\n${doc}`), false);
	// Positive control: a short operator request for a plan still arms.
	strictEqual(armed("Write a plan for adding a cache in front of the index."), true);
});

describe("turn_end effects inside one chat-loop run", () => {
	let env: IsolatedClioEnv;
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-turn-ending-");
		faux = registerEngineFauxProvider({ api: "turn-ending-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
	});
	afterEach(() => {
		faux.unregister();
		env.restore();
	});

	function fixture(turnEndEffects: (turnEnd: number) => MiddlewareEffect[]) {
		const requests: Context[] = [];
		faux.setResponses(
			Array.from({ length: 4 }, (_, index) => (context: Context) => {
				requests.push(structuredClone(context));
				return {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: `reply ${index + 1}` }],
					api: faux.api,
					provider: "fixture",
					model: "chat",
					stopReason: "stop" as const,
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			}),
		);
		const capabilities = { chat: true, tools: true, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
		const runtime = {
			id: "fixture",
			displayName: "Fixture",
			kind: "http",
			tier: "cloud",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: capabilities,
			synthesizeModel: (_target: unknown, id: string) => faux.getModel(id),
		} as unknown as RuntimeDescriptor;
		const target = {
			id: "chat-target",
			runtime: "fixture",
			url: "https://chat.invalid/v1",
			defaultModel: "chat",
			capabilities: { contextWindow: 131072 },
		};
		const providers = {
			list: () => [
				{
					target,
					runtime,
					available: true,
					capabilities,
					discoveredModels: ["chat"],
					discoveredModelsSource: "probe",
					probeCapabilities: null,
				},
			],
			getTarget: () => target,
			getRuntime: () => runtime,
			getDetectedReasoning: () => false,
		} as unknown as ProvidersContract;
		let turnEnds = 0;
		const middleware = {
			registerHook: () => {},
			runHook: (input: MiddlewareHookInput) => ({
				effects: input.hook === "turn_end" ? turnEndEffects(++turnEnds) : [],
				ruleIds: [],
			}),
		} as unknown as MiddlewareContract;
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = target.id;
		settings.chat.model = "chat";
		settings.chat.thinkingLevel = "off";
		settings.chat.prewarm = false;
		const loop = createChatLoop({
			getSettings: () => settings,
			providers,
			middleware,
			knownTargets: () => new Set([target.id]),
			createAgent: (options) => createEngineAgent(options),
			prompts: {
				inputEpoch: () => 0,
				compileSessionPrompt: async () => ({
					systemPrompt: "fixture prompt",
					systemPromptHash: "fixture",
					tokenEstimate: 1,
					sections: [],
					fragmentManifest: [],
				}),
			} as unknown as PromptsContract,
		});
		let agentEnds = 0;
		const notices: string[] = [];
		loop.onEvent((event) => {
			if (event.type === "agent_end") agentEnds += 1;
			if (event.type === "notice") notices.push(event.text);
		});
		return { loop, requests, notices, agentEnds: () => agentEnds };
	}

	const serialized = (context: Context | undefined) => JSON.stringify(context?.messages ?? []);

	it("carries a turn_end continuation inside the run and settles once", async () => {
		const nudge = "Open tasks remain; finish them before you answer.";
		const f = fixture((turnEnd) => (turnEnd === 1 ? [{ kind: "request_continuation", message: nudge }] : []));
		try {
			await f.loop.submit("do the task");
			strictEqual(f.requests.length, 2);
			ok(!serialized(f.requests[0]).includes(nudge));
			ok(serialized(f.requests[1]).includes(nudge), serialized(f.requests[1]));
			strictEqual(f.agentEnds(), 1);
		} finally {
			f.loop.dispose();
		}
	});

	it("delivers a model-audience reminder with the next request and never as a notice", async () => {
		const advice = "Model-only advice: a scout dispatch covers long read-only exploration.";
		const f = fixture((turnEnd) =>
			turnEnd === 1 ? [{ kind: "inject_reminder", message: advice, severity: "info", audience: "model" }] : [],
		);
		try {
			await f.loop.submit("look around");
			await f.loop.submit("next request");
			strictEqual(f.requests.length, 2);
			ok(serialized(f.requests[1]).includes(advice), serialized(f.requests[1]));
			ok(!f.notices.some((text) => text.includes(advice)), f.notices.join("\n"));
		} finally {
			f.loop.dispose();
		}
	});
});

it("detects explicit plan-only requests and removes only a trailing duplicated close", () => {
	const request = "Plan how to implement parseDuration. Give me the plan only; do not edit anything.";
	strictEqual(isPlanOnlyRequest(request), true);
	strictEqual(isPlanOnlyRequest("Plan the change and implement it."), false);
	strictEqual(isPlanOnlyRequest("Plan and implement the parser; do not change the public API."), false);
	strictEqual(isPlanOnlyRequest("Plan and implement this; do not edit tests."), false);
	strictEqual(isPlanOnlyRequest("Plan this change; do not implement it."), true);
	strictEqual(isPlanOnlyRequest("Do not edit anything; explain the parser."), false);
	const rule = createPlanCloseRegistration({ canAsk: () => true, isPlan: () => undefined });
	rule.evaluate({ hook: "turn_start", text: request });
	const close = rule.evaluate({ hook: "turn_end", text: "Plan", metadata: { stopReason: "stop" } });
	ok(close[0]?.kind === "request_continuation" && close[0].message.includes("Keep the plan (Recommended)"));
	strictEqual(
		stripPlanCloseOptions(
			"Plan\n- Keep this plan (Recommended) — no files changed.\n- Revise the plan — adjust parsing.",
		),
		"Plan",
	);
	strictEqual(stripPlanCloseOptions("Plan\n- Parse input\n- Return seconds"), "Plan\n- Parse input\n- Return seconds");
});
