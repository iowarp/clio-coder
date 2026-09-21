import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createMemoryPromptReader, type MemoryPromptRequest } from "../../src/domains/memory/prompt-cache.js";
import { memoryStorePath, readMemoryStoreSnapshot } from "../../src/domains/memory/store.js";
import type { CompiledSessionPrompt } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

function compiled(systemPrompt: string): CompiledSessionPrompt {
	return {
		systemPrompt,
		systemPromptHash: systemPrompt,
		tokenEstimate: Math.ceil(systemPrompt.length / 4),
		sections: [],
		fragmentManifest: [],
	};
}

function save(root: string, lesson: string): void {
	writeFileSync(
		memoryStorePath(root),
		JSON.stringify({
			version: 1,
			records: [
				{
					id: "mem-0000000000000001",
					scope: "global",
					key: "test",
					lesson,
					evidenceRefs: ["run:synthetic"],
					appliesWhen: [],
					avoidWhen: [],
					confidence: 0.9,
					createdAt: "2026-09-21T00:00:00.000Z",
					approved: true,
				},
			],
		}),
	);
}

test("the real prompt compiler callback preserves attempt/continuation bytes and binds a first session", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-memory-turn-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "memory"));
	save(root, "Original evidence.");
	let reads = 0;
	const read = createMemoryPromptReader({
		getDataDir: () => root,
		readStore: (dataDir) => {
			reads++;
			return readMemoryStoreSnapshot(dataDir);
		},
	});
	let sessionId: string | null = null;
	const calls: MemoryPromptRequest[] = [];
	const runtime = {
		targetId: "target",
		runtimeId: "runtime",
		wireModelId: "model",
		runtimeResolution: {
			capabilityDecisions: { tools: true },
			contextWindowDetails: { effectiveContextWindow: 32768, contextWindowSource: "loaded" },
		},
		agent: { state: { messages: [], tools: [], systemPrompt: "", model: {} } },
	} as unknown as AgentRuntime;
	const context = createTurnContext({
		state: createTurnState("off"),
		getSettings: () => DEFAULT_SETTINGS,
		providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
		middleware: {} as TurnMiddleware,
		session: {
			current: () => (sessionId === null ? null : ({ id: sessionId, cwd: root } as SessionMeta)),
		} as SessionContract,
		prompts: {
			inputEpoch: () => "0",
			compileSessionPrompt: async (input) => compiled(input.sessionInputs?.memorySection ?? ""),
			compileWorkerPrompt: async () => {
				throw new Error("not used");
			},
			reload() {},
		} as PromptsContract,
		getMemorySection: (request) => {
			calls.push(request);
			return read(request);
		},
		emitNotice: () => {},
	});
	t.after(() => context.dispose());
	await context.ensureSessionPrompt(runtime); // prewarm only
	strictEqual(calls.at(-1)?.turnId, null);
	save(root, "Prepared evidence.");
	context.addWorkingContextPaths(["src/first.ts"]);
	context.prepareMemoryTurn(runtime, { taskText: "operator task", continuation: false });
	const first = await context.ensureSessionPrompt(runtime);
	ok(first?.systemPrompt.includes("Prepared evidence"));
	const prepared = calls.at(-1);
	ok(prepared?.turnId);
	strictEqual(reads, 2);
	save(root, "Modified evidence.");
	sessionId = "created-after-preflight";
	context.commitMemoryTurn(runtime);
	context.addWorkingContextPaths(["src/later.ts"]);
	context.prepareMemoryTurn(runtime, { taskText: "synthetic continuation", continuation: true });
	const continuation = await context.ensureSessionPrompt(runtime);
	strictEqual(continuation?.systemPrompt, first?.systemPrompt);
	strictEqual(reads, 2, "first-session binding and tool continuation must not reread storage");
	strictEqual(calls.at(-1)?.sessionAuthority, prepared.sessionAuthority);
	strictEqual(calls.at(-1)?.taskText, "operator task");
	deepStrictEqual(calls.at(-1)?.activePaths, ["src/first.ts"]);
	context.prepareMemoryTurn(runtime, { taskText: "operator task", continuation: false });
	ok((await context.ensureSessionPrompt(runtime))?.systemPrompt.includes("Modified evidence"));
	notStrictEqual(calls.at(-1)?.turnId, prepared.turnId);
	strictEqual(reads, 3);
	save(root, "New runtime evidence.");
	runtime.runtimeId = "other-runtime";
	ok((await context.ensureSessionPrompt(runtime))?.systemPrompt.includes("New runtime evidence"));
	strictEqual(calls.at(-1)?.runtimeId, "other-runtime");
	save(root, "New session evidence.");
	sessionId = "other-session";
	ok((await context.ensureSessionPrompt(runtime))?.systemPrompt.includes("New session evidence"));
	strictEqual(calls.at(-1)?.turnId, null);
	const authority = calls.at(-1)?.sessionAuthority;
	context.resetForSession();
	save(root, "New branch evidence.");
	ok((await context.ensureSessionPrompt(runtime))?.systemPrompt.includes("New branch evidence"));
	notStrictEqual(calls.at(-1)?.sessionAuthority, authority);
	// The first-session alias is not valid if its actual runtime changed during
	// preflight; a subsequent compile must read under the new authority.
	sessionId = null;
	context.resetForSession();
	context.prepareMemoryTurn(runtime, { taskText: "fresh origin", continuation: false });
	await context.ensureSessionPrompt(runtime);
	const readsBeforeOriginChange = reads;
	save(root, "Changed origin evidence.");
	runtime.runtimeId = "third-runtime";
	sessionId = "created-on-changed-origin";
	context.commitMemoryTurn(runtime);
	ok((await context.ensureSessionPrompt(runtime))?.systemPrompt.includes("Changed origin evidence"));
	strictEqual(reads, readsBeforeOriginChange + 1);
});

test("real submit distinguishes rejected preflight, admitted turn, synthetic continuation and identical next input", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-memory-submit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "memory"));
	save(root, "First attempt evidence.");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "local";
	settings.chat.model = "local";
	settings.chat.prewarm = false;
	const capabilities = {
		chat: true,
		tools: true,
		reasoning: false,
		vision: false,
		audio: false,
		embeddings: false,
		rerank: false,
		fim: false,
		contextWindow: 32768,
		maxTokens: 1024,
	};
	const target = { id: "local", runtime: "local", url: "https://fixture.invalid", defaultModel: "local", capabilities };
	const model = {
		id: "local",
		name: "local",
		api: "openai-completions",
		provider: "local",
		baseUrl: target.url,
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const runtime = {
		id: "local",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: () => structuredClone(model),
	};
	const providers = {
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		list: () => [
			{
				target,
				runtime,
				capabilities,
				available: true,
				discoveredModels: ["local"],
				discoveredModelsSource: "probe",
				probeCapabilities: null,
			},
		],
	} as unknown as ProvidersContract;
	const read = createMemoryPromptReader({ getDataDir: () => root });
	const requests: MemoryPromptRequest[] = [];
	const sections: string[] = [];
	const submitted: string[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		knownTargets: () => new Set(["local"]),
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
			agent: {
				state: options?.initialState,
				subscribe: () => () => {},
				abort: () => {},
				prompt: async (text: string) => {
					submitted.push(text);
				},
			},
		})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
		getMemorySection: (request) => {
			requests.push(request);
			const section = read(request);
			sections.push(section);
			return section;
		},
		prompts: {
			inputEpoch: () => "0",
			compileSessionPrompt: async (input) => compiled(input.sessionInputs?.memorySection ?? ""),
			compileWorkerPrompt: async () => {
				throw new Error("not used");
			},
			reload() {},
		} as PromptsContract,
		autoCompact: async () => {
			throw new Error("fixture refuses compaction");
		},
	});
	t.after(() => loop.dispose());
	// Oversized submitted text reaches the actual admission estimator directly;
	// this fixture does not fake a systemPrompt getter on the engine adapter.
	await loop.submit("x".repeat(32769 * 4));
	deepStrictEqual(submitted, []);
	ok(requests[0]?.turnId);
	ok(sections[0]?.includes("First attempt evidence"));
	save(root, "Admitted turn evidence.");
	await loop.submit("same operator task");
	strictEqual(submitted.length, 1);
	notStrictEqual(requests[1]?.turnId, requests[0]?.turnId);
	ok(sections[1]?.includes("Admitted turn evidence"));
	save(root, "Next operator evidence.");
	await loop.submit("synthetic continuation", { requestContinuation: true });
	strictEqual(submitted.length, 2);
	strictEqual(requests[2]?.turnId, requests[1]?.turnId);
	strictEqual(requests[2]?.taskText, "same operator task");
	strictEqual(sections[2], sections[1]);
	await loop.submit("same operator task");
	strictEqual(submitted.length, 3);
	notStrictEqual(requests[3]?.turnId, requests[2]?.turnId);
	ok(sections[3]?.includes("Next operator evidence"));
});
