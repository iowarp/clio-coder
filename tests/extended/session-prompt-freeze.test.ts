import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
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
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { appendEntry, appendTurn, readCurrentEntries, startSession } from "../../src/domains/session/manager.js";
import { createEngineAgent, engineCodexConfiguration } from "../../src/engine/agent.js";
import { streamSimple } from "../../src/engine/ai.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { withCodexConfiguration } from "../../src/engine/apis/codex-configuration.js";
import { withCodexPromptItems } from "../../src/engine/apis/codex-prompt-items.js";
import type { CodexConfiguration } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { createTurnContext } from "../../src/session-control/turn-context.js";
import type { TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// #423: a mid-session change to the turn scope, approved memory, the workspace
// facts, the safety posture or the thinking level must leave the Codex request
// prefix byte-identical and reach the model, if at all, as a tail item.

const codex = openaiCodex.synthesizeModel({ id: "openai-codex", runtime: "openai-codex" }, "gpt-6-luna", null);
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.sig`;

/** The engine's streamSimple options carry the thinking level; plain StreamOptions do not. */
interface BodyOptions {
	reasoning?: SimpleStreamOptions["reasoning"];
	codexConfiguration?: CodexConfiguration;
}

/** The body Pi's Codex serializer builds for a captured context, after Clio's prompt-item and effort patches. */
async function codexBody(context: Context, options: BodyOptions = {}): Promise<Record<string, unknown>> {
	let captured: unknown;
	const stream = streamSimple(codex, context, {
		apiKey: token,
		sessionId: "freeze-session",
		...(options.reasoning ? { reasoning: options.reasoning } : {}),
		onPayload(payload) {
			captured = structuredClone(payload);
			throw new Error("Captured provider request before network I/O");
		},
	});
	for await (const _event of stream) {
		/* Stop before I/O. */
	}
	ok(captured, "the real Codex serializer must reach the payload hook");
	// The same order the engine registry applies: prompt items first, then the effort boundaries.
	const patched = withCodexConfiguration<StreamOptions>(
		codex,
		withCodexPromptItems<StreamOptions>(
			codex,
			options.codexConfiguration ? ({ codexConfiguration: options.codexConfiguration } as StreamOptions) : {},
		),
		context,
	);
	const moved = await patched?.onPayload?.(captured, codex);
	return (moved ?? captured) as Record<string, unknown>;
}

/** Everything but `input` is identical, and the later input extends the earlier one. */
async function assertPrefixKept(
	earlier: Context,
	later: Context,
	options: { earlier?: BodyOptions; later?: BodyOptions } = {},
): Promise<string> {
	const [a, b] = [await codexBody(earlier, options.earlier), await codexBody(later, options.later)];
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

/** The compiled prompt alone: a host policy update is a later system message, not a recompile. */
function compiledSystemText(context: Context | undefined): string {
	return JSON.stringify((context?.messages ?? []).find((message) => (message.role as string) === "system"));
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

	async function chatFixture(
		memory: { section: string },
		options: { autonomy?: { level: AutonomyLevel }; policyUpdates?: boolean } = {},
	) {
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
					usage,
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
			// The posture path needs the compat flag Pi's catalog gives gpt-6-luna.
			synthesizeModel: (_target: unknown, id: string) => ({
				...faux.getModel(id),
				...(options.policyUpdates ? { compat: { supportsMidConvoSystemMessages: true } } : {}),
			}),
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
		// A posture update is committed against the persisted user turn, so that path needs a session.
		const state = options.autonomy ? startSession({ cwd: process.cwd(), target: target.id, model: "chat" }) : undefined;
		let leaf: string | null = null;
		const session = state
			? ({
					current: () => state.meta,
					tree: () => ({ leafId: leaf }),
					append: (turn: Parameters<typeof appendTurn>[1]) => {
						const record = appendTurn(state, turn);
						leaf = record.id;
						return record;
					},
					appendEntry: (entry: Parameters<typeof appendEntry>[1]) => appendEntry(state, entry),
					readEntries: () => readCurrentEntries(state),
				} as unknown as SessionContract)
			: undefined;
		const loop = createChatLoop({
			getSettings: () => settings,
			...(options.autonomy ? { getAutonomy: () => options.autonomy?.level ?? "default" } : {}),
			providers,
			middleware: {
				registerHook: () => {},
				runHook: () => ({ effects: [], ruleIds: [] }),
			} as unknown as MiddlewareContract,
			knownTargets: () => new Set([target.id]),
			createAgent: (options) => createEngineAgent(options),
			prompts,
			getMemorySection: () => memory.section,
			...(session && state ? { session, readSessionEntries: () => readCurrentEntries(state) } : {}),
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

	it("keeps the prefix when autonomy toggles to yolo and delivers the posture as a host policy item", async () => {
		const autonomy = { level: "default" as AutonomyLevel };
		const f = await chatFixture({ section: "" }, { autonomy, policyUpdates: true });
		try {
			await f.loop.submit("first task");
			autonomy.level = "yolo";
			await f.loop.submit("second task");
			strictEqual(f.requests.length, 2);
			ok(compiledSystemText(f.requests[0]).includes("Autonomy: default."));
			strictEqual(compiledSystemText(f.requests[1]), compiledSystemText(f.requests[0]));
			const tail = await assertPrefixKept(f.requests[0] as Context, f.requests[1] as Context);
			const items = JSON.parse(tail) as Array<{ type?: string; role?: string; content?: unknown }>;
			const text = (item: { content?: unknown }) => (typeof item.content === "string" ? item.content : "");
			const policy = items.find((item) => text(item).startsWith("[Clio Coder host policy update]"));
			ok(policy, tail);
			strictEqual(policy.role, "developer");
			ok(text(policy).includes("Autonomy: yolo."), tail);
			ok(text(policy).includes("The operator turned on yolo"), tail);
			strictEqual(items.at(-1)?.role, "user");
		} finally {
			f.loop.dispose();
		}
	});

	it("keeps the prefix when /thinking changes and sends the effort as a configuration_update before the new user item", async () => {
		const state = startSession({ cwd: process.cwd(), target: "openai-codex", model: codex.id });
		const session = {
			current: () => state.meta,
			tree: () => ({ leafId: null }),
			appendEntry: (entry: Parameters<typeof appendEntry>[1]) => appendEntry(state, entry),
			readEntries: () => readCurrentEntries(state),
		} as unknown as SessionContract;
		const turnState = createTurnState("off");
		const turn = createTurnContext({
			state: turnState,
			getSettings: () => structuredClone(DEFAULT_SETTINGS),
			providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
			session,
			readSessionEntries: () => readCurrentEntries(state),
			middleware: {} as TurnMiddleware,
			emitNotice: () => {},
		});
		const agent = {
			state: { systemPrompt: "You are Clio.", thinkingLevel: "medium", messages: [], tools: [], model: codex },
		};
		const agentRuntime = {
			targetId: "openai-codex",
			runtimeId: "openai-codex",
			wireModelId: codex.id,
			runtimeResolution: {
				effectiveThinkingLevel: "medium",
				capabilityDecisions: { tools: true },
				contextWindowDetails: { effectiveContextWindow: 272_000, contextWindowSource: "catalog" },
			},
			agent,
		} as unknown as AgentRuntime;
		const user = (text: string, at: string) => ({ role: "user" as const, content: text, timestamp: Date.parse(at) });
		const reply = (at: string) => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "reply 1" }],
			api: codex.api,
			provider: codex.provider,
			model: codex.id,
			stopReason: "stop" as const,
			timestamp: Date.parse(at),
			usage,
		});
		try {
			// The runtime records the level each turn starts at; the first record is the configuration baseline.
			appendEntry(state, {
				kind: "thinkingLevelChange",
				parentTurnId: null,
				thinkingLevel: "medium",
				effectiveEffort: "medium",
				configurationInitial: true,
			});
			const first = appendTurn(state, { parentId: null, kind: "user", payload: { text: "first task" } });
			turnState.lastTurnId = first.id;
			turnState.activeUserTurnId = first.id;
			agent.state.messages = [user("first task", first.at)] as never;
			turn.commitMemoryTurn(agentRuntime);
			strictEqual(turn.thinkingUsesConfigurationUpdate(), false);
			const before = engineCodexConfiguration(agent as never);
			deepStrictEqual(before, { initialEffort: "medium", updates: [] });
			const earlier: Context = { systemPrompt: agent.state.systemPrompt, messages: [...agent.state.messages] };
			const answered = appendTurn(state, { parentId: first.id, kind: "assistant", payload: reply(first.at) });
			// /thinking high, then the next submit.
			appendEntry(state, {
				kind: "thinkingLevelChange",
				parentTurnId: answered.id,
				thinkingLevel: "high",
				effectiveEffort: "high",
			});
			agentRuntime.runtimeResolution.effectiveThinkingLevel = "high";
			const second = appendTurn(state, { parentId: answered.id, kind: "user", payload: { text: "second task" } });
			turnState.lastTurnId = second.id;
			turnState.activeUserTurnId = second.id;
			agent.state.messages = [...agent.state.messages, reply(answered.at), user("second task", second.at)] as never;
			turn.commitMemoryTurn(agentRuntime);
			strictEqual(turn.thinkingUsesConfigurationUpdate(), true);
			const after = engineCodexConfiguration(agent as never);
			deepStrictEqual(after, { initialEffort: "medium", updates: [{ position: second.id, effort: "high" }] });
			const later: Context = { systemPrompt: agent.state.systemPrompt, messages: [...agent.state.messages] };
			const tail = await assertPrefixKept(earlier, later, {
				earlier: { reasoning: "medium", codexConfiguration: before },
				later: { reasoning: "high", codexConfiguration: after },
			});
			// The tail is the first reply, the effort boundary, then the new user item.
			const items = JSON.parse(tail) as Array<Record<string, unknown>>;
			strictEqual(items.length, 3);
			strictEqual(items[0]?.role, "assistant");
			deepStrictEqual(items[1], { type: "configuration_update", reasoning: { effort: "high" } });
			strictEqual(items[2]?.role, "user");
			const body = await codexBody(later, { reasoning: "high", codexConfiguration: after });
			deepStrictEqual((body.reasoning as { effort: string }).effort, "medium");
		} finally {
			turn.dispose();
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
