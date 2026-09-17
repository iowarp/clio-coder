import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const target = { id: "stall-fixture", runtime: "litellm", url: "http://fixture.invalid:4000" };
const model = litellm.synthesizeModel(target, "stall-model", null) as Model<"openai-completions">;
const capabilities = {
	chat: true,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 131072,
	maxTokens: 4096,
};

/**
 * `cold` answers after `firstTokenDelayMs` of silence, the way a server that
 * slept reloads and prefills before its first token. `wedged` streams one delta
 * and then never speaks again.
 */
function transport(mode: "cold" | "wedged", firstTokenDelayMs: number) {
	let calls = 0;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		calls += 1;
		const signal = init?.signal;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ id: "stall", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
						),
					);
				let timer: ReturnType<typeof setTimeout> | null = null;
				signal?.addEventListener(
					"abort",
					() => {
						if (timer) clearTimeout(timer);
						controller.error(new DOMException("The operation was aborted", "AbortError"));
					},
					{ once: true },
				);
				if (mode === "wedged") {
					send({ role: "assistant", content: "PARTIAL" });
					return;
				}
				timer = setTimeout(() => {
					send({ role: "assistant", content: "COLD_START_ANSWER" });
					send({}, "stop");
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				}, firstTokenDelayMs);
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, calls: () => calls };
}

function fixture(mode: "cold" | "wedged", firstTokenDelayMs = 0) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.chat.retry = { ...settings.chat.retry, enabled: false, streamStallMs: 150, firstTokenStallMs: 5_000 };
	settings.targets = [{ ...target, defaultModel: model.id }];
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: () => ({ ...model, contextWindow: 131072, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const wire = transport(mode, firstTokenDelayMs);
	const events: ChatLoopEvent[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		bus: context.bus,
		createAgent: (options) =>
			createEngineAgent({
				...options,
				streamFn: (requestModel, requestContext, requestOptions) =>
					openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
						...requestOptions,
						apiKey: "fixture",
						fetch: (...args) => wire.fetch(...args),
					}),
			}),
	});
	loop.onEvent((event) => events.push(event));
	const text = (): string => events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");
	return { loop, events, wire, text };
}

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("first-token-stall-");
	previousCwd = process.cwd();
	const project = join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

it("a cold backend that is silent past the mid-stream window before its first token completes the turn", {
	timeout: 20_000,
}, async () => {
	// Four mid-stream windows of silence, as a sleeping llama-server reloading
	// and prefilling, well inside the first-token window.
	const f = fixture("cold", 600);
	try {
		await f.loop.submit("hello");
		await f.loop.whenSettled();
		strictEqual(f.text(), "COLD_START_ANSWER");
		strictEqual(f.wire.calls(), 1, "the healthy call was not aborted and retried");
	} finally {
		f.loop.dispose();
		await f.loop.whenSettled();
	}
});

it("a stream that goes silent after its first token still aborts on the mid-stream window", {
	timeout: 20_000,
}, async () => {
	const f = fixture("wedged");
	try {
		const started = performance.now();
		await f.loop.submit("hello");
		await f.loop.whenSettled();
		const elapsed = performance.now() - started;
		ok(elapsed < 4_000, `the first-token window must not delay a wedged stream (${Math.round(elapsed)}ms)`);
		const failure = JSON.stringify(f.events);
		match(failure, /stream stalled: no output from stall-fixture/u);
	} finally {
		f.loop.dispose();
		await f.loop.whenSettled();
	}
});
