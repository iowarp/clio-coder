import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import { createWorkerOutputCapture } from "../../src/domains/dispatch/event-pump.js";
import { classifyFailure, decideRetry } from "../../src/domains/dispatch/failure-classification.js";
import { isRunOutcomeCode } from "../../src/domains/dispatch/types.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { withLocalResidency } from "../../src/engine/apis/openai-completions.js";
import type { EngineModel } from "../../src/engine/types.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import { boundWorkerResponse } from "../../src/engine/worker-response-stream.js";
import { startWorkerRun } from "../../src/engine/worker-runtime.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

type Stream = ReturnType<typeof boundWorkerResponse>;
type Message = Awaited<ReturnType<Stream["result"]>>;
const model = {
	id: "fixture",
	name: "fixture",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	contextWindow: 131072,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies EngineModel;
const message = (text: string): Message => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	timestamp: 1,
	stopReason: "stop",
	usage: {
		input: 9,
		output: 4,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 13,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

for (const limit of [
	{ locked: false, configured: 600, seconds: 600 },
	{ locked: true, configured: 600, seconds: 120 },
	{ locked: true, configured: 1, seconds: 1 },
]) {
	test(`native response deadline (${limit.seconds}s, locked=${limit.locked}) settles before a late tool batch`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let now = 0;
		let invoked = 0;
		let signal: AbortSignal | undefined;
		let observe!: () => void;
		const observed = new Promise<void>((resolve) => {
			observe = resolve;
		});
		let completeLate!: (message: Message) => void;
		const late = new Promise<Message>((resolve) => {
			completeLate = resolve;
		});
		const partial = message("unfinished answer");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial };
				observe();
				const completed = await late;
				yield { type: "done", reason: "toolUse", message: completed };
			},
			result: () => late,
		} as unknown as Stream;
		const outcomes: Array<{ code: string; detail: string }> = [];
		const capture = createWorkerOutputCapture();
		const { agent } = createEngineAgent({
			initialState: {
				model,
				tools: [
					{
						name: "late",
						label: "late",
						description: "late",
						parameters: {} as never,
						execute: async () => {
							invoked++;
							return { content: [{ type: "text", text: "ran" }], details: {} };
						},
					},
				],
			},
			getApiKey: async () => "fixture",
			streamFn: (current, context, options) =>
				boundWorkerResponse(
					current,
					context,
					{ ...options, maxTokens: 512 },
					{
						locked: limit.locked,
						responseSeconds: limit.configured,
						round: 3,
						onLimit: (code, detail) => outcomes.push({ code, detail }),
					},
					(options) => {
						signal = options.signal;
						strictEqual(options.maxTokens, 512, "retain a tighter output limit");
						return source;
					},
					() => now,
				),
		});
		agent.subscribe((event) => capture.observe(event));
		let settled = false;
		const run = agent.prompt("respond").then(() => {
			settled = true;
		});
		await observed;
		now = limit.seconds * 1000;
		t.mock.timers.tick(limit.seconds * 1000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		strictEqual(settled, true, "the local agent must finish before the provider answers");
		await run;
		strictEqual(signal?.aborted, true);
		strictEqual(outcomes[0]?.code, "worker_turn_timeout");
		match(outcomes[0]?.detail ?? "", new RegExp(`round 3.*${limit.seconds} second`));
		strictEqual(capture.snapshot()?.state, "partial");
		strictEqual(capture.snapshot()?.text, "unfinished answer");
		const terminal = agent.state.messages.at(-1) as Message;
		strictEqual(terminal.stopReason, "aborted");
		deepStrictEqual(terminal.usage, partial.usage);
		completeLate({
			...message("late"),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "late", name: "late", arguments: {} }],
		});
		await Promise.resolve();
		await Promise.resolve();
		strictEqual(invoked, 0);
		strictEqual(agent.state.messages.at(-1), terminal);
	});
}

test("locked native worker rounds disable thinking, send the 4096 cap and fail on provider output exhaustion", async () => {
	const env = await isolateClioEnv("worker-response-cap-");
	writeFileSync(join(env.dir, "input.txt"), "known evidence");
	const requests: Array<{
		max_tokens?: number;
		tools?: unknown[];
		chat_template_kwargs?: { enable_thinking?: boolean };
	}> = [];
	const outcomes: ClioWorkerEvent[] = [];
	const capture = createWorkerOutputCapture();
	const server = createServer(async (req, res) => {
		requests.push(JSON.parse(await readRequestBody(req)));
		const working = requests.length === 1;
		const delta = working
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "read",
							type: "function",
							function: { name: "read", arguments: JSON.stringify({ path: "input.txt" }) },
						},
					],
				}
			: { role: "assistant", content: "unfinished report" };
		res.setHeader("content-type", "text/event-stream");
		res.end(
			`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: working ? "tool_calls" : "length" }], usage: { prompt_tokens: 17, completion_tokens: 4096, total_tokens: 4113 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const worker = startWorkerRun(
			{
				agentId: "coder",
				systemPrompt: "Read then report.",
				task: "Read input.txt then report.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "qwen3-8b",
				apiKey: "fixture",
				thinkingLevel: "high",
				modelCapabilities: {
					contextWindow: 131072,
					maxTokens: 8192,
					tools: true,
					reasoning: true,
					thinkingFormat: "qwen-chat-template",
					thinkingControlRuntime: "llamacpp",
				},
				allowedTools: ["read"],
				budget: { mode: "enforced", toolCalls: 1, readReserve: 0, synthesis: true, hardCap: 150 },
				noSkills: true,
				cwd: env.dir,
				onPermission: "deny",
			},
			(event) => {
				capture.observe(event);
				if (event.type === "clio_coder_run_outcome") outcomes.push(event);
			},
		);
		const result = await worker.promise;
		strictEqual(requests.length, 2);
		strictEqual(requests[0]?.chat_template_kwargs?.enable_thinking, true);
		strictEqual(requests[1]?.chat_template_kwargs?.enable_thinking, false);
		strictEqual(requests[1]?.max_tokens, 4096);
		strictEqual(requests[1]?.tools?.length ?? 0, 0);
		strictEqual(result.exitCode, 1);
		const outcome = outcomes.find((event) => event.type === "clio_coder_run_outcome");
		ok(outcome?.type === "clio_coder_run_outcome");
		strictEqual(outcome.payload.outcomeCode, "worker_output_cap_exhausted");
		match(outcome.payload.detail ?? "", /round 2.*4096 token/);
		strictEqual(capture.snapshot()?.state, "partial");
		strictEqual(capture.snapshot()?.text, "unfinished report");
	} finally {
		await closeServer(server);
		env.restore();
	}
});

test("worker response seconds validates as a positive integer and takes effect on next dispatch", () => {
	strictEqual(DEFAULT_SETTINGS.safety.limits.workerResponseSeconds, 600);
	match(DEFAULT_SETTINGS_YAML, /workerResponseSeconds: 600/);
	const valid = validateSettings({ safety: { limits: { workerResponseSeconds: 42 } } });
	deepStrictEqual(valid.issues, []);
	strictEqual(valid.settings.safety.limits.workerResponseSeconds, 42);
	for (const value of [0, -1, 0.5, "600"]) {
		ok(
			validateSettings({ safety: { limits: { workerResponseSeconds: value } } }).issues.some(
				(issue) => issue.path === "safety.limits.workerResponseSeconds",
			),
		);
	}
	ok(diffSettings(DEFAULT_SETTINGS, valid.settings).nextTurn.includes("safety.limits.workerResponseSeconds"));
	for (const code of ["worker_turn_timeout", "worker_output_cap_exhausted"]) {
		ok(isRunOutcomeCode(code));
		ok(isDeterministicOutcomeCode(code));
		const failure = classifyFailure(
			{
				exitCode: 1,
				abortedByOperator: false,
				stallKilled: false,
				timedOut: false,
				permissionFailure: false,
				policyDenied: null,
				stopReason: null,
			},
			null,
			"failed",
			code,
		);
		strictEqual(failure, "deterministic-task");
		strictEqual(decideRetry(failure, 0, 3).retry, false);
	}
});

for (const code of ["worker_turn_timeout", "worker_output_cap_exhausted"] as const) {
	test(`${code} survives receipt sealing and suppresses dispatch retry and breaker penalties`, async () => {
		await isolateDispatchState();
		let spawns = 0;
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 2;
		const detail = `${code}: round 3 exceeded its response limit`;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: () => {
				spawns++;
				return {
					pid: null,
					promise: Promise.resolve({ exitCode: 1, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => {},
					send: () => true,
					events: (async function* () {
						yield { type: "clio_coder_run_outcome", payload: { outcomeCode: code, detail } };
					})(),
				};
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				task: "Inspect available exports.",
				executionRole: "researcher",
				requestOrigin: "internal",
			});
			const receipt = await run.finalPromise;
			strictEqual(receipt.outcome, "failed");
			strictEqual(receipt.outcomeCode, code);
			ok(receipt.outcomeDetail?.includes(detail));
			strictEqual(spawns, 1);
			deepStrictEqual(bundle.contract.routeBreakers?.(), []);
		} finally {
			await bundle.extension.stop?.();
			restoreDispatchState();
		}
	});
}

for (const terminalEvent of [true, false]) {
	test(`unlocked length stops preserve Pi truncation recovery (terminal event=${terminalEvent})`, async () => {
		const truncated = { ...message("truncated"), stopReason: "length" as const };
		const source = {
			async *[Symbol.asyncIterator]() {
				if (terminalEvent) yield { type: "done", reason: "length", message: truncated };
			},
			result: async () => truncated,
		} as unknown as Stream;
		const codes: string[] = [];
		const stream = boundWorkerResponse(
			model,
			{ messages: [] },
			undefined,
			{
				locked: false,
				responseSeconds: 600,
				round: 1,
				onLimit: (code) => codes.push(code),
			},
			() => source,
		);
		strictEqual((await stream.result()).stopReason, "length");
		deepStrictEqual(codes, []);
	});
}

for (const reported of [false, true]) {
	test(`timed-out compatible stream records usage as ${reported ? "reported" : "unknown"}`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let now = 0;
		let observe!: () => void;
		const observed = new Promise<void>((resolve) => {
			observe = resolve;
		});
		const partial = message("unfinished");
		partial.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const stream = boundWorkerResponse(
			model,
			{ messages: [] },
			undefined,
			{
				locked: false,
				responseSeconds: 600,
				round: 1,
				onLimit: () => {},
			},
			(options) =>
				({
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial };
						if (reported)
							await options.onProviderStreamEvent?.(
								{ usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
								model,
							);
						observe();
						await new Promise(() => {});
					},
					result: () => new Promise(() => {}),
				}) as unknown as Stream,
			() => now,
		);
		await observed;
		now = 600_000;
		t.mock.timers.tick(600_000);
		const result = await stream.result();
		if (reported) {
			strictEqual(result.usage.totalTokens, 13);
		} else {
			strictEqual((result.usage as unknown as { observed: boolean }).observed, false);
		}
	});
}

test("response deadline starts after local residency finishes", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 0;
	let finishLoad!: () => void;
	const load = new Promise<void>((resolve) => {
		finishLoad = resolve;
	});
	let loading!: () => void;
	const requested = new Promise<void>((resolve) => {
		loading = resolve;
	});
	t.mock.method(globalThis, "fetch", async () => {
		loading();
		await load;
		return new Response(null, { status: 404 });
	});
	const localModel = {
		...model,
		provider: "llamacpp",
		clioCoder: { runtimeId: "llamacpp", targetId: "deadline-fixture" },
	};
	const codes: string[] = [];
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const stream = boundWorkerResponse(
		localModel,
		{ messages: [] },
		undefined,
		{
			locked: true,
			responseSeconds: 600,
			round: 1,
			onLimit: (code) => codes.push(code),
		},
		(options) =>
			withLocalResidency(localModel, options, () => {
				ready();
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: message("pending") };
						await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
					},
					result: async () => message("pending"),
				} as unknown as Stream;
			}),
		() => now,
	);
	try {
		now = 240_000;
		await requested;
		t.mock.timers.tick(240_000);
		deepStrictEqual(codes, [], "loading must not consume the response deadline");
		finishLoad();
		await started;
		now += 119_999;
		t.mock.timers.tick(119_999);
		deepStrictEqual(codes, []);
		now++;
		t.mock.timers.tick(1);
		strictEqual((await stream.result()).stopReason, "aborted");
		deepStrictEqual(codes, ["worker_turn_timeout"]);
	} finally {
		finishLoad();
	}
});
