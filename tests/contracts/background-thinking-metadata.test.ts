import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { runTaskMemoryPolicy, type TaskMemoryModelClient } from "../../src/domains/memory/task-memory-policy.js";
import { createProvidersBundle } from "../../src/domains/providers/extension.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { appendEntry, appendTurn, startSession } from "../../src/domains/session/manager.js";
import { createBackgroundMemoryModelClient, createProductionAutoCompact } from "../../src/entry/orchestrator.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function setup(runtime = "lm-studio", beforeMetadata?: () => Promise<void>) {
	const env = await isolateClioEnv("clio-background-thinking-");
	const fixture = await startGatewayThinkingFixture(runtime, "zbook/ornith-1.5-35b-a3b", beforeMetadata);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "memory", runtime: "litellm", url: fixture.url, defaultModel: fixture.modelId },
		{ id: "chat", runtime: "litellm", url: fixture.url, defaultModel: "dynamo/qwen3.8-27b" },
	];
	settings.context.memory.target = "memory";
	settings.context.memory.model = fixture.modelId;
	settings.context.compaction.model = `memory/${fixture.modelId}`;
	settings.chat.target = "chat";
	settings.chat.model = "dynamo/qwen3.8-27b";
	const bundle = createProvidersBundle(dispatchStubContext({ settings }));
	for (const target of settings.targets) bundle.contract.auth.setRuntimeOverrideForTarget(target, litellm, "fixture");
	await bundle.extension.start();
	return {
		env,
		fixture,
		settings,
		providers: bundle.contract,
		close: async () => {
			await bundle.extension.stop?.();
			await fixture.close();
			env.restore();
		},
	};
}

for (const role of ["memory", "compaction"] as const) {
	test(`cold dedicated ${role} discovers its own gateway controls before actual completion`, async () => {
		const f = await setup();
		try {
			strictEqual(f.providers.list()[0]?.health.lastCheckAt, null);
			strictEqual(f.fixture.requests.length, 0);
			if (role === "memory") {
				const route = createBackgroundMemoryModelClient(f.providers, f.settings, 1000, null);
				ok(route);
				const result: Awaited<ReturnType<TaskMemoryModelClient["complete"]>> = await route.client.complete({
					systemPrompt: "fixture",
					userPrompt: "17 times 19",
					maxTokens: 4096,
					signal: new AbortController().signal,
				});
				strictEqual(f.fixture.requests[0]?.max_tokens, 1024, "fresh discovered output limit bounds memory");
				strictEqual(result.text, "323");
				strictEqual(result.usage?.reasoning, 0);
			} else {
				const state = startSession({ cwd: f.env.dir, target: "chat", model: f.settings.chat.model });
				let leaf: string | null = null;
				for (let i = 0; i < 6; i++)
					leaf = appendTurn(state, {
						parentId: leaf,
						kind: "user",
						payload: { text: `history ${i} ${"x".repeat(24000)}` },
					}).id;
				const session = {
					current: () => state.meta,
					tree: () => ({ leafId: leaf }),
					appendEntry: (entry: Parameters<typeof appendEntry>[1]) => appendEntry(state, entry),
				} as unknown as SessionContract;
				ok(await createProductionAutoCompact(session, () => f.settings, f.providers)());
			}
			ok(f.fixture.requests.length > 0, "real HTTP completions occurred");
			for (const request of f.fixture.requests) {
				strictEqual(request.model, f.fixture.modelId);
				strictEqual(request.reasoning_effort, "none");
				deepStrictEqual(request.allowed_openai_params, ["reasoning_effort"]);
			}
			strictEqual(f.fixture.paths.filter((path) => path === "/v1/model/info").length, 1);
			strictEqual(f.providers.list()[1]?.health.lastCheckAt, null, "no unrelated target probe");
		} finally {
			await f.close();
		}
	});
}

for (const ending of ["deadline", "cancelled"] as const) {
	test(`memory ${ending} during metadata does not launch late inference or poison target health`, {
		timeout: 5000,
	}, async () => {
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const f = await setup("lm-studio", async () => {
			entered();
			await gate;
		});
		try {
			const route = createBackgroundMemoryModelClient(f.providers, f.settings, 1000, null);
			ok(route);
			const controller = new AbortController();
			let completion: ReturnType<typeof route.client.complete> | undefined;
			let usage = 0;
			const policy = runTaskMemoryPolicy(
				new TaskMemoryBank(),
				{
					complete: (request) => {
						completion = route.client.complete(request);
						return completion;
					},
				},
				{
					task: "fixture",
					deterministicTrigger: true,
					trajectory: [],
					maxTokens: 512,
					timeoutMs: ending === "deadline" ? 100 : 2000,
					signal: controller.signal,
					onStepUsage: () => {
						usage++;
					},
				},
			);
			await started;
			if (ending === "cancelled") controller.abort();
			const result = await policy;
			strictEqual(result.reason, ending === "deadline" ? "deadline" : "scope_changed");
			release();
			await completion?.catch(() => undefined);
			strictEqual(f.fixture.requests.length, 0, "expired metadata cannot spend inference");
			strictEqual(usage, 0, "metadata is not model usage");
			strictEqual(f.providers.list()[0]?.health.lastCheckAt, null, "abort is not endpoint-down evidence");
			const recovered = await route.client.complete({
				systemPrompt: "fixture",
				userPrompt: "17 times 19",
				maxTokens: 512,
				signal: new AbortController().signal,
			});
			strictEqual(recovered.usage?.reasoning, 0);
			strictEqual(f.fixture.requests.length, 1, "fresh generation can discover and complete");
		} finally {
			release();
			await f.close();
		}
	});
}

test("successful unknown background metadata remains unknown and is not repeatedly probed", async () => {
	const f = await setup("unknown");
	try {
		const route = createBackgroundMemoryModelClient(f.providers, f.settings, 1000, null);
		ok(route);
		for (let i = 0; i < 2; i++) {
			const result: Awaited<ReturnType<TaskMemoryModelClient["complete"]>> = await route.client.complete({
				systemPrompt: "fixture",
				userPrompt: "17 times 19",
				maxTokens: 512,
				signal: new AbortController().signal,
			});
			strictEqual(result.usage?.reasoning, 8, "returned reasoning remains observable");
			strictEqual(f.fixture.requests.at(-1)?.reasoning_effort, undefined);
			strictEqual(f.fixture.requests.at(-1)?.allowed_openai_params, undefined);
		}
		strictEqual(f.fixture.paths.filter((path) => path === "/v1/model/info").length, 1);
	} finally {
		await f.close();
	}
});

test("compaction rechecks its origin after cold metadata preparation before spending inference", async () => {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const f = await setup("lm-studio", async () => {
		entered();
		await gate;
	});
	try {
		const state = startSession({ cwd: f.env.dir, target: "chat", model: f.settings.chat.model });
		let leaf: string | null = null;
		for (let i = 0; i < 6; i++)
			leaf = appendTurn(state, { parentId: leaf, kind: "user", payload: { text: "x".repeat(24000) } }).id;
		let current = state.meta;
		const session = {
			current: () => current,
			tree: () => ({ leafId: leaf }),
			appendEntry: (entry: Parameters<typeof appendEntry>[1]) => appendEntry(state, entry),
		} as unknown as SessionContract;
		const result = createProductionAutoCompact(session, () => f.settings, f.providers)();
		await started;
		current = { ...current, id: "changed-session" };
		release();
		let error: unknown;
		try {
			await result;
		} catch (caught) {
			error = caught;
		}
		ok(error instanceof Error && error.message.includes("changed before summarization"));
		strictEqual(f.fixture.requests.length, 0);
	} finally {
		release();
		await f.close();
	}
});

test("memory refuses an endpoint changed while metadata was pending", async () => {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const f = await setup("lm-studio", async () => {
		entered();
		await gate;
	});
	try {
		const route = createBackgroundMemoryModelClient(f.providers, f.settings, 1000, null);
		ok(route);
		const completion = route.client.complete({
			systemPrompt: "fixture",
			userPrompt: "fixture",
			maxTokens: 512,
			signal: new AbortController().signal,
		});
		await started;
		f.settings.targets[0]!.url = "http://changed.invalid:4000";
		release();
		let error: unknown;
		try {
			await completion;
		} catch (caught) {
			error = caught;
		}
		ok(error instanceof Error && error.message.includes("target changed during preparation"));
		strictEqual(f.fixture.requests.length, 0);
	} finally {
		release();
		await f.close();
	}
});
