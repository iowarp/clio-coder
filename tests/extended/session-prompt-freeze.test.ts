import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context, StreamOptions } from "@earendil-works/pi-ai";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { TurnConstraints } from "../../src/core/turn-constraints.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import type { PromptsContract } from "../../src/domains/prompts/index.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import openaiCodex from "../../src/domains/providers/runtimes/cloud/openai-codex.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { streamSimple } from "../../src/engine/ai.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { withCodexPromptItems } from "../../src/engine/apis/codex-prompt-items.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { createTurnContext } from "../../src/session-control/turn-context.js";
import type { TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// #423: a mid-session change to the turn scope, approved memory or the
// workspace facts must leave the Codex request prefix byte-identical and reach
// the model, if at all, as tail text.

const codex = openaiCodex.synthesizeModel({ id: "openai-codex", runtime: "openai-codex" }, "gpt-6-luna", null);
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.sig`;

/** The body Pi's Codex serializer builds for a captured context, after Clio's prompt-item move. */
async function codexBody(context: Context): Promise<Record<string, unknown>> {
	let captured: unknown;
	const stream = streamSimple(codex, context, {
		apiKey: token,
		sessionId: "freeze-session",
		onPayload(payload) {
			captured = structuredClone(payload);
			throw new Error("Captured provider request before network I/O");
		},
	});
	for await (const _event of stream) {
		/* Stop before I/O. */
	}
	ok(captured, "the real Codex serializer must reach the payload hook");
	const moved = await withCodexPromptItems<StreamOptions>(codex, {})?.onPayload?.(captured, codex);
	return (moved ?? captured) as Record<string, unknown>;
}

/** Everything but `input` is identical, and the later input extends the earlier one. */
async function assertPrefixKept(earlier: Context, later: Context): Promise<string> {
	const [a, b] = [await codexBody(earlier), await codexBody(later)];
	const rest = (body: Record<string, unknown>) => ({ ...body, input: undefined });
	deepStrictEqual(rest(b), rest(a));
	const before = a.input as unknown[];
	const after = b.input as unknown[];
	ok(after.length > before.length);
	deepStrictEqual(after.slice(0, before.length), before);
	return JSON.stringify(after.slice(before.length));
}

/** Pi 1.1 carries the system prompt as the leading system message. */
function systemText(context: Context | undefined): string {
	return JSON.stringify((context?.messages ?? []).filter((message) => (message.role as string) === "system"));
}

function memorySection(lessons: readonly string[]): string {
	return [
		"# Memory",
		"",
		"Long-term memory records that may apply.",
		"",
		...lessons.map(
			(lesson, index) => `- [mem-${index + 1}] (scope=global; operator-approved) ${lesson} Evidence: run:x.`,
		),
	].join("\n");
}

describe("frozen session prompt across mid-session changes", { concurrency: false }, () => {
	let env: IsolatedClioEnv;
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	const originalCwd = process.cwd();
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-prompt-freeze-");
		faux = registerEngineFauxProvider({ api: "prompt-freeze-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		process.chdir(cwd);
	});
	afterEach(() => {
		process.chdir(originalCwd);
		faux.unregister();
		env.restore();
	});

	async function promptsBundle() {
		const bus = createSafeEventBus();
		const config = { get: () => structuredClone(DEFAULT_SETTINGS), onChange: () => () => {} };
		const agents = { revision: () => 1, listSpecs: () => [] } as unknown as AgentsContract;
		const domainContext: DomainContext = {
			bus,
			getContract(name) {
				if (name === "config") return config as never;
				if (name === "agents") return agents as never;
				if (name === "context") return context.contract as never;
				return undefined;
			},
		};
		const context = createContextBundle(domainContext);
		const prompts = createPromptsBundle(domainContext);
		await context.extension.start();
		await prompts.extension.start();
		return { bus, prompts: prompts.contract };
	}

	async function chatFixture(memory: { section: string }) {
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
					timestamp: 0,
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
		const target = { id: "chat-target", runtime: "fixture", url: "https://chat.invalid/v1", defaultModel: "chat" };
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
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = target.id;
		settings.chat.model = "chat";
		settings.chat.thinkingLevel = "off";
		settings.chat.prewarm = false;
		const { prompts } = await promptsBundle();
		const loop = createChatLoop({
			getSettings: () => settings,
			providers,
			middleware: {
				registerHook: () => {},
				runHook: () => ({ effects: [], ruleIds: [] }),
			} as unknown as MiddlewareContract,
			knownTargets: () => new Set([target.id]),
			createAgent: (options) => createEngineAgent(options),
			prompts,
			getMemorySection: () => memory.section,
		});
		return { loop, requests };
	}

	it("keeps the prefix when the turn scope changes and delivers the new scope in the tail", async () => {
		const f = await chatFixture({ section: "" });
		try {
			const answer: TurnConstraints = { mode: "answer" };
			const change: TurnConstraints = { mode: "change", delegation: "forbidden" };
			await f.loop.submit("first task", { constraints: answer });
			await f.loop.submit("second task", { constraints: change });
			strictEqual(f.requests.length, 2);
			strictEqual(systemText(f.requests[1]), systemText(f.requests[0]));
			const tail = await assertPrefixKept(f.requests[0] as Context, f.requests[1] as Context);
			ok(tail.includes("Carry out the requested change within the authorized scope."), tail);
			ok(tail.includes("Work directly; do not delegate."), tail);
		} finally {
			f.loop.dispose();
		}
	});

	it("keeps the prefix when memory gains a record and delivers the record in the tail", async () => {
		const memory = { section: memorySection(["Run the focused test first."]) };
		const f = await chatFixture(memory);
		try {
			await f.loop.submit("first task");
			memory.section = memorySection(["Run the focused test first.", "Never edit generated wiki pages."]);
			await f.loop.submit("second task");
			await f.loop.submit("third task");
			strictEqual(f.requests.length, 3);
			ok(systemText(f.requests[0]).includes("Run the focused test first."));
			strictEqual(systemText(f.requests[1]), systemText(f.requests[0]));
			const tail = await assertPrefixKept(f.requests[0] as Context, f.requests[1] as Context);
			ok(tail.includes("# Memory update"), tail);
			ok(tail.includes("Never edit generated wiki pages."), tail);
			// History already carries the record, so the next turn does not repeat it.
			const next = await assertPrefixKept(f.requests[1] as Context, f.requests[2] as Context);
			strictEqual(next.includes("Never edit generated wiki pages."), false, next);
		} finally {
			f.loop.dispose();
		}
	});

	it("keeps the prefix when a config reload re-captures session sources", async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T10:00:00.000Z") });
		const { bus, prompts } = await promptsBundle();
		let compiles = 0;
		const counted: PromptsContract = {
			...prompts,
			async compileSessionPrompt(input) {
				compiles += 1;
				return prompts.compileSessionPrompt(input);
			},
		};
		const turn = createTurnContext({
			state: createTurnState("off"),
			getSettings: () => structuredClone(DEFAULT_SETTINGS),
			providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
			prompts: counted,
			session: {
				current: () => ({ id: "freeze-session", cwd: process.cwd(), createdAt: "2026-10-20T10:00:00.000Z" }),
				appendEntry: (entry: unknown) => entry,
			} as never,
			middleware: {} as TurnMiddleware,
			emitNotice: () => {},
		});
		const agentRuntime = {
			targetId: "openai-codex",
			runtimeId: "openai-codex",
			wireModelId: "gpt-6-luna",
			runtimeResolution: {
				capabilityDecisions: { tools: true },
				contextWindowDetails: { effectiveContextWindow: 272_000, contextWindowSource: "catalog" },
			},
			agent: { state: { systemPrompt: "", thinkingLevel: "off", messages: [], tools: [] } },
		} as unknown as AgentRuntime;
		try {
			const first = (await turn.ensureSessionPrompt(agentRuntime))?.systemPrompt ?? "";
			ok(first.includes("Session context:"), first);
			t.mock.timers.tick(5 * 60_000);
			bus.emit(BusChannels.ConfigHotReload, {
				diff: { hotReload: [], nextTurn: [], restartRequired: [] },
				settings: DEFAULT_SETTINGS,
			});
			const second = (await turn.ensureSessionPrompt(agentRuntime))?.systemPrompt ?? "";
			strictEqual(compiles, 2, "the reload must reach a real recompile");
			strictEqual(second, first);
			const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
			const reply = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "reply 1" }],
				api: codex.api,
				provider: codex.provider,
				model: codex.id,
				stopReason: "stop" as const,
				timestamp: 0,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			await assertPrefixKept(
				{ systemPrompt: first, messages: [user("first task")] },
				{ systemPrompt: second, messages: [user("first task"), reply, user("second task")] },
			);
		} finally {
			turn.dispose();
		}
	});
});
