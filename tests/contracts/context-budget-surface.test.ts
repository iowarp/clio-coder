import { deepStrictEqual, doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import fs, { readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { configureGuardrails } from "../../src/core/guardrails.js";
import type { BudgetInspection } from "../../src/domains/context/budget/inspection.js";
import type { LiveBudgetView } from "../../src/domains/context/budget/live-view.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { sessionPaths } from "../../src/engine/session.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { AgentMessage, Usage } from "../../src/engine/types.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createRegistry, type ToolRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const WINDOW = 32_768;
const usage: Usage = {
	input: 9000,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9050,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function result(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "r1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

async function inspect(registry: ToolRegistry) {
	const verdict = await registry.invoke({ tool: "context", args: { scope: "budget" } });
	ok(verdict.kind === "ok", JSON.stringify(verdict));
	ok(verdict.result.kind === "ok", JSON.stringify(verdict));
	return {
		result: verdict.result,
		payload: JSON.parse(verdict.result.output) as BudgetInspection & { mode: string; admissionNote: string },
	};
}
function viewOf(payload: BudgetInspection): LiveBudgetView {
	ok(payload.status === "available", JSON.stringify(payload));
	return payload.view;
}
function files(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

describe("native budget inspection through the registered context tool", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-budget-surface-");
	});
	afterEach(() => {
		configureGuardrails(undefined);
		env.restore();
	});

	function fixture(capture = true) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = "fixture";
		settings.chat.model = "model";
		settings.context.compaction.threshold = 0.85;
		const state = createTurnState("medium");
		const descriptor = {
			id: "fixture",
			kind: "http",
			apiFamily: "openai-completions",
			defaultCapabilities: { chat: true, tools: true, reasoning: false, contextWindow: WINDOW, maxTokens: 8192 },
		} as AgentRuntime["runtimeResolution"]["runtime"];
		const runtime = {
			targetId: "fixture",
			runtimeId: "fixture",
			wireModelId: "model",
			runtimeResolution: {
				runtime: descriptor,
				capabilityDecisions: { maxTokens: 8192 },
				contextWindowDetails: {
					desiredContextWindow: WINDOW,
					effectiveContextWindow: WINDOW,
					contextWindowSource: "configured",
				},
			},
			agent: createEngineAgent({
				initialState: {
					model: {
						id: "model",
						api: "openai-completions",
						contextWindow: WINDOW,
						maxTokens: 8192,
					} as AgentRuntime["agent"]["state"]["model"],
					systemPrompt: "System prompt.",
					tools: [],
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Inspect the source." }],
							usage,
							api: "openai-completions",
							provider: "fixture",
							model: "model",
							stopReason: "toolUse",
							timestamp: 1,
						},
					],
				},
			}).agent,
		} as unknown as AgentRuntime;
		state.runtime = runtime;
		state.lastTurnId = "leaf";
		const providers = {
			list: () => [],
			getTarget: () => ({ id: "fixture", runtime: "fixture" }),
			getDetectedReasoning: () => false,
			knowledgeBase: null,
			getRuntime: () => descriptor,
		} as unknown as ProvidersContract;
		const meta = { id: "surface-session", cwdHash: "surface-fixture", cwd: env.dir } as SessionMeta;
		let ledgerReads = 0;
		let writes = 0;
		let reductions = 0;
		const context = createTurnContext({
			middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
			state,
			providers,
			getSettings: () => settings,
			session: {
				current: () => meta,
				appendEntry: () => {
					writes++;
				},
			} as unknown as SessionContract,
			readSessionEntries: () => {
				ledgerReads++;
				return [];
			},
			autoCompact: async () => {
				reductions++;
				return null;
			},
			emitNotice: () => {},
		});
		if (capture) {
			context.setCurrentSnapshot(context.captureRuntimeContextSnapshot(runtime, "leaf", 0.85));
			context.reconcileUsage(usage);
		}
		const registry = createRegistry({
			safety: createWorkerSafety({ cwd: env.dir }),
			autonomy: () => "default",
			readOnly: true,
		});
		registerAllTools(registry, { mcpCapabilities: false, getContextBudget: () => context.inspectLiveBudget() });
		return {
			settings,
			state,
			runtime,
			descriptor,
			providers,
			context,
			registry,
			meta,
			counters: () => ({ ledgerReads, writes, reductions }),
		};
	}

	it("refreshes after tool growth, shares the UI revision, and leaves accounting reads free of persistence/reduction", async () => {
		const f = fixture();
		const first = await inspect(f.registry);
		strictEqual(first.payload.mode, "enforced");
		match(first.payload.admissionNote, /input plus reserved output/);
		const before = viewOf(first.payload);
		f.runtime.agent.state.messages.push(result("漢字".repeat(8000)));
		const grown = viewOf((await inspect(f.registry)).payload);
		notStrictEqual(grown.revision, before.revision);
		ok((grown.inputTokens ?? 0) > (before.inputTokens ?? 0));
		strictEqual(grown.inputTokens, f.context.liveContextEstimate(f.runtime).tokens);
		strictEqual(f.context.contextUsage().revision, grown.revision);
		strictEqual(f.context.contextUsage().tokens, grown.inputTokens);
		strictEqual(grown.outputReserveTokens, 8192);
		notStrictEqual(grown.thresholdReserveTokens, grown.outputReserveTokens);
		f.context.persistContextSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "leaf", 0.85));
		const snapshots = join(dirname(sessionPaths(f.meta).current), "context-snapshots.jsonl");
		const persisted = readFileSync(snapshots, "utf8");
		const counters = f.counters();
		const beforeFiles = files(env.dir);
		for (let i = 0; i < 3; i++) {
			strictEqual(viewOf((await inspect(f.registry)).payload).revision, grown.revision);
			strictEqual(f.context.contextUsage().revision, grown.revision);
		}
		deepStrictEqual(f.counters(), counters);
		strictEqual(readFileSync(snapshots, "utf8"), persisted);
		deepStrictEqual(files(env.dir), beforeFiles);
		strictEqual(f.registry.get("context")?.baseActionClass, "read");
		strictEqual(f.registry.get("context")?.executionMode, "parallel");
	});

	it("detects schema, window, policy, same-length content, and actual branch navigation at inspection", async () => {
		const f = fixture();
		let revision = viewOf((await inspect(f.registry)).payload).revision;
		for (const mutate of [
			() => {
				f.runtime.agent.state.tools = [
					{
						name: "read",
						description: "changed schema",
						parameters: { type: "object" },
						execute: async () => ({ content: [], details: {} }),
					} as never,
				];
			},
			() => {
				f.runtime.runtimeResolution.contextWindowDetails.effectiveContextWindow = 40_000;
			},
			() => {
				f.settings.context.compaction.threshold = 0.9;
			},
			() => {
				f.runtime.agent.state.messages[0] = {
					...f.runtime.agent.state.messages[0],
					content: [{ type: "text", text: "X".repeat("Inspect the source.".length) }],
				} as AgentMessage;
			},
			() => {
				f.context.resetForSession("sibling-leaf");
			},
		]) {
			mutate();
			const next = viewOf((await inspect(f.registry)).payload);
			notStrictEqual(next.revision, revision);
			strictEqual(f.context.contextUsage().revision, next.revision);
			revision = next.revision;
		}
		strictEqual(f.context.liveBudget().branchAnchorTurnId, "sibling-leaf");
		strictEqual(f.context.liveBudget().policy.reduce, 0.9);
	});

	it("renders published totals even beside an older ledger and keeps narrow footer rows bounded", async () => {
		const f = fixture();
		const oldLedger = f.context.contextLedger();
		f.runtime.agent.state.messages.push(result("x".repeat(24_000)));
		const grown = viewOf((await inspect(f.registry)).payload);
		const counters = f.counters();
		let terminalWidth = 120;
		const panel = buildFooterDashboard({
			providers: f.providers,
			getSettings: () => f.settings,
			getContextUsage: () => f.context.contextUsage(),
			getContextLedger: () => oldLedger,
			getTerminalColumns: () => terminalWidth,
			resolveCurrentBranch: async () => null,
		});
		try {
			const text = panel.view.render(120).map(stripTerminalSequences).join("\n");
			match(text, /~15\.1k \/ 32\.8k/);
			ok(!text.includes("9.1k /"), text);
			for (const width of [24, 40, 72, 120]) {
				terminalWidth = width;
				panel.refresh();
				ok(panel.view.render(width).every((line) => visibleWidth(line) <= width));
			}
			strictEqual(f.context.liveBudget().revision, grown.revision);
			deepStrictEqual(f.counters(), counters);
		} finally {
			panel.dispose();
		}
	});

	it("retains historical provenance without initializing a runtime and visibly distinguishes unknown measurements", async () => {
		const f = fixture();
		f.state.runtime = null;
		f.settings.chat.model = null;
		const historical = viewOf((await inspect(f.registry)).payload);
		strictEqual(historical.historical, true);
		strictEqual(historical.inputSource, "historical");
		strictEqual(historical.outputReserveTokens, null);
		strictEqual(historical.admission.result, "unknown");
		strictEqual(f.state.runtime, null);
		const panel = buildFooterDashboard({
			providers: f.providers,
			getContextUsage: () => f.context.contextUsage(),
			getTerminalColumns: () => 120,
			resolveCurrentBranch: async () => null,
		});
		try {
			match(panel.view.render(120).map(stripTerminalSequences).join("\n"), /saved /);
		} finally {
			panel.dispose();
		}
	});

	it("does not rescan diagnostic snapshots on a pre-runtime budget read, even after passive settings change", async () => {
		const f = fixture();
		f.context.persistContextSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "leaf", 0.85));
		const watched = join(dirname(sessionPaths(f.meta).current), "context-snapshots.jsonl");
		// Load the lazy runner before instrumenting builtin I/O, then watch the
		// actual path the owning persistence seam wrote (with a positive control).
		await inspect(f.registry);
		const originalRead = fs.readFileSync;
		let reads = 0;
		const mocked = mock.method(fs, "readFileSync", (...args: unknown[]) => {
			if (String(args[0]) === watched) reads++;
			return Reflect.apply(originalRead, fs, args);
		});
		syncBuiltinESMExports();
		try {
			readFileSync(watched, "utf8");
			strictEqual(reads, 1, "the watcher sees a real read of the persisted snapshot path");
			reads = 0;
			f.state.runtime = null;
			const before = viewOf((await inspect(f.registry)).payload);
			strictEqual(before.historical, true);
			f.settings.context.compaction.threshold = 0.9;
			const changed = viewOf((await inspect(f.registry)).payload);
			notStrictEqual(changed.revision, before.revision);
			strictEqual(changed.policy.reduce, 0.9);
			f.settings.chat.model = "another-model";
			const rerouted = viewOf((await inspect(f.registry)).payload);
			notStrictEqual(
				rerouted.revision,
				changed.revision,
				"a changed configured route invalidates historical publication even at the same window",
			);
			f.context.contextUsage();
			f.context.contextLedger();
			strictEqual(reads, 0, "neither inspection reads the diagnostic ledger");
			strictEqual(f.state.runtime, null);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
		}
	});

	it("renders missing measurements as unknown rather than zero", async () => {
		const f = fixture(false);
		f.state.runtime = null;
		f.settings.chat.model = null;
		const view = viewOf((await inspect(f.registry)).payload);
		strictEqual(view.inputTokens, null);
		strictEqual(view.outputReserveTokens, null);
		strictEqual(view.inputSource, "unknown");
		const panel = buildFooterDashboard({
			providers: f.providers,
			getContextUsage: () => f.context.contextUsage(),
			getTerminalColumns: () => 120,
			resolveCurrentBranch: async () => null,
		});
		try {
			match(panel.view.render(120).map(stripTerminalSequences).join("\n"), /\? \/ \?/);
		} finally {
			panel.dispose();
		}
	});

	it("does not display the whole known window as free when input is unknown", async () => {
		const f = fixture(false);
		f.state.runtime = null;
		const view = viewOf((await inspect(f.registry)).payload);
		strictEqual(view.inputTokens, null);
		strictEqual(view.effectiveWindow, WINDOW);
		const panel = buildFooterDashboard({
			providers: f.providers,
			getContextUsage: () => f.context.contextUsage(),
			getTerminalColumns: () => 120,
			resolveCurrentBranch: async () => null,
		});
		try {
			const text = panel.view.render(120).map(stripTerminalSequences).join("\n");
			match(text, /\? \/ 32\.8k/);
			doesNotMatch(text, /free 32\.8k/);
		} finally {
			panel.dispose();
		}
	});

	it("keeps saved route and window coherent after configuration moves to a different model", async () => {
		const f = fixture();
		const original = viewOf((await inspect(f.registry)).payload);
		f.state.runtime = null;
		f.settings.chat.target = "other-target";
		f.settings.chat.model = "other-model";
		f.descriptor.defaultCapabilities.contextWindow = 131_072;
		const saved = viewOf((await inspect(f.registry)).payload);
		strictEqual(saved.historical, true);
		strictEqual(saved.targetId, original.targetId);
		strictEqual(saved.modelId, original.modelId);
		strictEqual(saved.effectiveWindow, original.effectiveWindow);
		notStrictEqual(saved.effectiveWindow, 131_072);
		notStrictEqual(saved.revision, original.revision);
		strictEqual(f.state.runtime, null);
	});

	it("composes the late-bound ChatLoop port without creating an engine or probing for inspection", async () => {
		const f = fixture(false);
		f.settings.chat.model = null;
		f.settings.chat.prewarm = false;
		let engines = 0;
		let probes = 0;
		f.providers.probeTarget = async () => {
			probes++;
			return null;
		};
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }) });
		// The registration precedes ChatLoop construction, just as entry does.
		registerAllTools(registry, { mcpCapabilities: false, getContextBudget: () => chat.inspectLiveBudget() });
		const chat = createChatLoop({
			getSettings: () => f.settings,
			providers: f.providers,
			knownTargets: () => new Set(["fixture"]),
			toolRegistry: registry,
			createAgent: (options) => {
				engines++;
				return createEngineAgent(options);
			},
		});
		try {
			const before = { engines, probes };
			const view = viewOf((await inspect(registry)).payload);
			strictEqual(view.inputTokens, null);
			strictEqual(chat.contextUsage().revision, view.revision);
			strictEqual(chat.liveBudget().revision, view.revision);
			deepStrictEqual({ engines, probes }, before);
		} finally {
			chat.dispose();
		}
	});

	it("refuses absent and external authority, including the production worker registry", async () => {
		const f = fixture();
		const worker = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: env.dir }));
		strictEqual((await inspect(worker)).payload.status, "unavailable");
		f.descriptor.externalAgentLoop = {
			tools: "externally-governed-unobserved",
			network: "externally-governed-unobserved",
			budget: "external-one-shot",
			generatingRetry: "forbidden",
			modelCatalog: "static",
		};
		strictEqual((await inspect(f.registry)).payload.status, "unsupported");
		f.state.runtime = null;
		strictEqual((await inspect(f.registry)).payload.status, "unsupported");
		delete f.descriptor.externalAgentLoop;
		f.descriptor.kind = "sdk";
		f.descriptor.apiFamily = "claude-agent-sdk";
		strictEqual(
			(await inspect(f.registry)).payload.status,
			"unsupported",
			"delegated SDK runtimes also lack native budget authority",
		);
	});

	it("validates budget-only arguments before reading and returns bounded JSON without an offload", async () => {
		const f = fixture();
		for (const args of [{ scope: "budget", query: "secret" }, { scope: "budget", offset: 0 }, { scope: "wrong" }]) {
			const verdict = await f.registry.invoke({ tool: "context", args });
			ok(verdict.kind === "ok");
			strictEqual(verdict.result.kind, "error");
		}
		const view = viewOf((await inspect(f.registry)).payload);
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }) });
		registerAllTools(registry, {
			mcpCapabilities: false,
			getContextBudget: () => ({
				status: "available",
				capability: "native",
				view: { ...view, modelId: "漢".repeat(50_000) },
			}),
		});
		const beforeFiles = files(env.dir);
		const observed = await inspect(registry);
		strictEqual(observed.payload.status, "unavailable");
		ok(Buffer.byteLength(observed.result.output) < 1024);
		ok(!observed.result.output.includes("offloadPath"));
		deepStrictEqual(files(env.dir), beforeFiles);
		configureGuardrails({ observationTurnBudgetBytes: 1024 });
		const limited = await createContextTool({
			getContextBudget: () => ({ status: "available", capability: "native", view }),
		}).run({ scope: "budget" }, { sessionId: "limited", turnId: "one" });
		ok(limited.kind === "ok");
		strictEqual(JSON.parse(limited.output).reason, "observation-limit");
		const budgetTool = createContextTool({
			getContextBudget: () => {
				throw new Error("exhausted reads cannot call the provider");
			},
		});
		const exhaustedOptions = { sessionId: "limited", turnId: "one" };
		const invalid = await budgetTool.run({ scope: "budget", offset: 0 }, exhaustedOptions);
		ok(invalid.kind === "error");
		match(invalid.message, /accepts only scope/);
		for (let i = 0; i < 3; i++) {
			const exhausted = await budgetTool.run({ scope: "budget" }, exhaustedOptions);
			ok(exhausted.kind === "ok");
			strictEqual(JSON.parse(exhausted.output).reason, "observation-budget-exhausted");
			ok(Buffer.byteLength(exhausted.output) <= 1024);
			const details = exhausted.details as { observation: { format: string; shownBytes: number } };
			strictEqual(details.observation.format, "json");
			strictEqual(details.observation.shownBytes, Buffer.byteLength(exhausted.output));
		}
		const terminal = await budgetTool.run({ scope: "budget" }, exhaustedOptions);
		strictEqual(terminal.kind, "error", "the existing fourth-exhaustion stop remains enforced");

		ok(Buffer.byteLength(limited.output) <= 1024);
		deepStrictEqual(files(env.dir), beforeFiles);
	});
});
