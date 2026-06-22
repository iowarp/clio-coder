import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { spawnNativeWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { WORKER_RUNTIME_DESCRIPTOR_VERSION, WORKER_SPEC_VERSION } from "../../src/worker/spec-contract.js";
import { createWorkerStdinDemux } from "../../src/worker/stdin-demux.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function emptyEvents(): AsyncIterableIterator<unknown> {
	return (async function* () {})();
}

const MINIMAL_SPEC_LINE = `${JSON.stringify({
	specVersion: WORKER_SPEC_VERSION,
	runtime: {
		version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
		id: "x",
		kind: "http",
		apiFamily: "openai-responses",
		auth: "none",
	},
	runtimeId: "x",
	systemPrompt: "",
	agentId: "coder",
	task: "t",
	target: { id: "e", runtime: "x" },
	wireModelId: "m",
	allowedTools: ["bash"],
})}\n`;

function stubContext(): DomainContext {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target: TargetDescriptor = { id: "default", runtime: "openai", defaultModel: "gpt-4o" };
	settings.targets = [target];
	settings.workers.default.target = target.id;
	settings.workers.default.model = "gpt-4o";

	const runtime: RuntimeDescriptor = {
		id: target.runtime,
		displayName: "OpenAI",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: target.defaultModel, provider: target.runtime }) as never,
	};
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: [],
	};
	const providers: ProvidersContract = {
		list: () => [status],
		getTarget: (id) => (id === target.id ? target : null),
		getRuntime: (id) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeTarget: async () => status,
		disconnectTarget: () => status,
		auth: {
			statusForTarget: () => ({
				providerId: runtime.id,
				available: true,
				credentialType: null,
				source: "none",
				detail: null,
			}),
			resolveForTarget: async () => ({
				providerId: runtime.id,
				available: true,
				credentialType: null,
				source: "none",
				detail: null,
			}),
			getStored: () => null,
			listStored: () => [],
			setApiKey: () => {},
			remove: () => {},
			login: async () => {},
			logout: () => {},
			getOAuthProviders: () => [],
			setRuntimeOverrideForTarget: () => {},
			clearRuntimeOverrideForTarget: () => {},
		},
		credentials: {
			hasKey: () => false,
			get: () => null,
			set: () => {},
			remove: () => {},
		},
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	};

	const config: ConfigContract = {
		get: () => settings,
		onChange: () => () => {},
	};

	const safety: SafetyContract = {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: {
			readonly: READONLY_SCOPE,
			workspace: WORKSPACE_SCOPE,
			confirmed: CONFIRMED_SCOPE,
		},
		isSubset,
		audit: { recordCount: () => 0 },
	};

	const recipes: ReadonlyArray<AgentRecipe> = [
		{
			id: "coder",
			name: "coder",
			description: "test recipe",
			source: "builtin" as const,
			filepath: "/test/coder.md",
			body: "# Test Recipe",
		},
	];
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe ? normalizeAgentSpec(recipe) : null;
		},
		reload: () => {},
		parseFleet: () => ({ steps: [] }),
	};

	const middleware = createMiddlewareBundle().contract;
	const bus = createSafeEventBus();
	const getContract = ((name: string) => {
		if (name === "config") return config;
		if (name === "safety") return safety;
		if (name === "agents") return agents;
		if (name === "scheduling")
			return {
				ceilingUsd: () => 5,
				checkCeiling: () => "under",
				raiseCeiling: () => {},
				preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: 5 }),
				activeWorkers: () => 0,
				tryAcquireWorker: () => true,
				releaseWorker: () => {},
				listNodes: () => [],
			};
		if (name === "providers") return providers;
		if (name === "middleware") return middleware;
		return undefined;
	}) as DomainContext["getContract"];

	return { bus, getContract };
}

describe("contracts/worker-steer", () => {
	describe("stdin demux", () => {
		it("dispatches a post-spec steer line to the registered handler", async () => {
			const demux = createWorkerStdinDemux();
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed(`${JSON.stringify({ type: "steer", text: "focus on tests/" })}\n`);
			const spec = await demux.readSpec();
			strictEqual(spec.agentId, "coder");
			deepStrictEqual(received, ["focus on tests/"]);
			strictEqual(demux.droppedLineCount(), 0);
		});

		it("buffers steers that arrive before the handler registers and flushes them in order", () => {
			const demux = createWorkerStdinDemux();
			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed(`${JSON.stringify({ type: "steer", text: "first" })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "second" })}\n`);
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			deepStrictEqual(received, ["first", "second"]);
			demux.feed(`${JSON.stringify({ type: "steer", text: "third" })}\n`);
			deepStrictEqual(received, ["first", "second", "third"]);
		});

		it("counts and drops malformed, unknown, and empty post-spec lines without losing later steers", () => {
			const demux = createWorkerStdinDemux();
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			demux.feed(MINIMAL_SPEC_LINE);
			demux.feed("not json at all\n");
			demux.feed(`${JSON.stringify({ type: "mystery" })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "   " })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: 42 })}\n`);
			demux.feed(`${JSON.stringify({ type: "steer", text: "still works" })}\n`);
			deepStrictEqual(received, ["still works"]);
			strictEqual(demux.droppedLineCount(), 4);
		});

		it("handles spec and steer arriving in one chunk and split steer lines across chunks", async () => {
			const demux = createWorkerStdinDemux();
			const received: string[] = [];
			demux.onSteer((text) => received.push(text));
			const steerLine = `${JSON.stringify({ type: "steer", text: "split delivery" })}\n`;
			const combined = MINIMAL_SPEC_LINE + steerLine;
			demux.feed(combined.slice(0, MINIMAL_SPEC_LINE.length + 5));
			demux.feed(combined.slice(MINIMAL_SPEC_LINE.length + 5));
			await demux.readSpec();
			deepStrictEqual(received, ["split delivery"]);
		});
	});

	describe("spawned worker send", () => {
		it("delivers a steer line to the child stdin and reports false after exit", async () => {
			const scratch = mkdtempSync(join(tmpdir(), "clio-steer-transport-"));
			const stubEntry = join(scratch, "stub-entry.js");
			// Reads the spec line, echoes the next stdin line back as an event,
			// then exits. Models a worker consuming a steer mid-run.
			writeFileSync(
				stubEntry,
				`
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let sawSpec = false;
rl.on("line", (line) => {
	if (!sawSpec) { sawSpec = true; return; }
	process.stdout.write(JSON.stringify({ type: "stub_echo", line: JSON.parse(line) }) + "\\n");
	process.exit(0);
});
`,
			);
			chmodSync(stubEntry, 0o755);
			try {
				const worker = spawnNativeWorker(
					{
						specVersion: WORKER_SPEC_VERSION,
						systemPrompt: "",
						agentId: "coder",
						task: "t",
						target: { id: "e", runtime: "x" } as never,
						runtime: {
							version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
							id: "x",
							kind: "http",
							apiFamily: "openai-responses",
							auth: "none",
						},
						runtimeId: "x",
						wireModelId: "m",
						allowedTools: ["bash"],
					} as never,
					{ workerEntryPath: stubEntry },
				);

				ok(worker.send, "spawnNativeWorker must expose send");
				strictEqual(worker.send?.({ type: "steer", text: "pivot now" }), true);

				const events: unknown[] = [];
				for await (const ev of worker.events) events.push(ev);
				const exit = await worker.promise;
				strictEqual(exit.exitCode, 0);
				const echo = events.find(
					(ev) => !!ev && typeof ev === "object" && (ev as { type?: unknown }).type === "stub_echo",
				) as { line?: unknown } | undefined;
				deepStrictEqual(echo?.line, { type: "steer", text: "pivot now" });

				strictEqual(worker.send?.({ type: "steer", text: "too late" }), false);
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		});
	});

	describe("dispatch contract steer", () => {
		beforeEach(isolateDispatchState);
		afterEach(restoreDispatchState);

		it("forwards a trimmed steer line to the active native worker", async () => {
			const context = stubContext();
			const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
			const sent: unknown[] = [];

			const bundle = makeDispatchBundle(context, {
				spawnWorker: () => ({
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					send: (value: unknown) => {
						sent.push(value);
						return true;
					},
				}),
			});

			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "steerable" });
				bundle.contract.steer(handle.runId, "  focus on tests/  ");
				deepStrictEqual(sent, [{ type: "steer", text: "focus on tests/" }]);
				exit.resolve({ exitCode: 0, signal: null });
				await handle.finalPromise;
			} finally {
				await bundle.extension.stop?.();
			}
		});

		it("rejects steers for unknown runs, finished runs, empty text, and dead stdin", async () => {
			const context = stubContext();
			const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
			let sendAlive = true;

			const bundle = makeDispatchBundle(context, {
				spawnWorker: () => ({
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					send: () => sendAlive,
				}),
			});

			await bundle.extension.start();
			try {
				throws(() => bundle.contract.steer("no-such-run", "hello"), /not active/);

				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "lifecycle" });
				throws(() => bundle.contract.steer(handle.runId, "   "), /empty message/);

				sendAlive = false;
				throws(() => bundle.contract.steer(handle.runId, "hello"), /no longer accepts input/);

				exit.resolve({ exitCode: 0, signal: null });
				await handle.finalPromise;
				throws(() => bundle.contract.steer(handle.runId, "hello"), /not active/);
			} finally {
				await bundle.extension.stop?.();
			}
		});

		it("rejects steers for runs whose handle has no input channel", async () => {
			const context = stubContext();
			const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();

			const bundle = makeDispatchBundle(context, {
				spawnWorker: () => ({
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				}),
			});

			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "channel-less" });
				throws(() => bundle.contract.steer(handle.runId, "hello"), /no input channel/);
				exit.resolve({ exitCode: 0, signal: null });
				await handle.finalPromise;
			} finally {
				await bundle.extension.stop?.();
			}
		});
	});
});
