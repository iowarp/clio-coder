import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import type { BudgetAlertPayload } from "../../src/core/telemetry/live-events.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createSchedulingBundle } from "../../src/domains/scheduling/extension.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";
import { budgetAlertNotice } from "../../src/interactive/bus-notices.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
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
	let keepAlive: ReturnType<typeof setInterval> | undefined;
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
						clearInterval(keepAlive);
						controller.error(new DOMException("The operation was aborted", "AbortError"));
					},
					{ once: true },
				);
				if (mode === "wedged") {
					// A real open HTTP connection keeps Node alive. The fixture must
					// do the same while the production stall watchdog is unref'd.
					keepAlive = setInterval(() => {}, 1000);
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
	return { fetch, calls: () => calls, dispose: () => clearInterval(keepAlive) };
}

/** A priced target whose session already spent past its ceiling, so every request waits at budget admission. */
interface BudgetFixture {
	spentUsd: number;
	ceilingUsd: number;
	headless?: boolean;
	retry?: boolean;
}

function fixture(mode: "cold" | "wedged", firstTokenDelayMs = 0, budget?: BudgetFixture) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.chat.retry = {
		...settings.chat.retry,
		enabled: budget?.retry === true,
		baseDelayMs: 1,
		streamStallMs: 150,
		firstTokenStallMs: 5_000,
	};
	// The budget cases run on a generic route, whose retry ladder reads provider
	// error text the way the openai-codex route in #423 did; LiteLLM's is narrower.
	const runtimeId = budget ? "openai-compat" : litellm.id;
	settings.targets = [
		{
			...target,
			runtime: runtimeId,
			defaultModel: model.id,
			...(budget ? { pricing: { input: 1, output: 1 } } : {}),
		},
	];
	if (budget) settings.safety.limits.sessionCostUsd = budget.ceilingUsd;
	const runtime: RuntimeDescriptor = {
		...litellm,
		id: runtimeId,
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: () => ({ ...model, contextWindow: 131072, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const wire = transport(mode, firstTokenDelayMs);
	const events: ChatLoopEvent[] = [];
	const alerts: BudgetAlertPayload[] = [];
	context.bus.subscribe("budget.alerted", (payload) => {
		alerts.push(payload);
	});
	const spent = { sessionCost: () => budget?.spentUsd ?? 0 } as unknown as TelemetryContract;
	const scheduling = budget
		? createSchedulingBundle(
				{
					bus: context.bus,
					getContract: ((name: string) =>
						name === "telemetry" ? spent : context.getContract(name)) as DomainContext["getContract"],
				},
				{ getSettings: () => settings },
			).contract
		: undefined;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		bus: context.bus,
		...(scheduling ? { scheduling } : {}),
		...(budget?.headless ? { headless: true } : {}),
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
	return { loop, events, wire, text, settings, alerts };
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
		f.wire.dispose();
		await f.loop.whenSettled();
	}
});

it("a stream that goes silent after its first token still aborts on the mid-stream window", {
	timeout: 20_000,
}, async () => {
	const f = fixture("wedged");
	try {
		await f.loop.submit("hello");
		await f.loop.whenSettled();
		strictEqual(f.text(), "PARTIAL", "the mid-stream watchdog follows an actual first token");
		const failure = JSON.stringify(f.events);
		match(failure, /stream stalled: no output from stall-fixture/u);
	} finally {
		f.loop.dispose();
		f.wire.dispose();
		await f.loop.whenSettled();
	}
});

it("a request parked at the session cost ceiling outlasts the stall window and runs once the ceiling is raised", {
	timeout: 20_000,
}, async () => {
	// #423: the watchdog aborted this wait as "no output from openai-codex" and
	// retried it into the same ceiling. Four stall windows pass before the raise.
	const f = fixture("cold", 0, { spentUsd: 5.01, ceilingUsd: 5, retry: true });
	const raise = setTimeout(() => {
		f.settings.safety.limits.sessionCostUsd = 50;
	}, 600);
	try {
		await f.loop.submit("hello");
		await f.loop.whenSettled();
		strictEqual(f.text(), "COLD_START_ANSWER");
		strictEqual(f.wire.calls(), 1, "the parked request was invoked once, after the raise");
		doesNotMatch(JSON.stringify(f.events), /stalled|aborted before invocation/u);
		strictEqual(f.alerts.length, 1);
		ok((f.alerts[0]?.contextTokens ?? 0) > 0, "the stop carries the parked request's context size");
		match(
			budgetAlertNotice(f.alerts[0])?.text ?? "",
			/\$5\.01 of \$5\.00 ceiling exceeded\. The next call sends ~[\d,]+ context tokens\./u,
		);
	} finally {
		clearTimeout(raise);
		f.loop.dispose();
		f.wire.dispose();
		await f.loop.whenSettled();
	}
});

it("a headless request at the ceiling ends on the budget error without a retry, even when the spend reads like a 500", {
	timeout: 20_000,
}, async () => {
	const f = fixture("cold", 0, { spentUsd: 1.5003, ceilingUsd: 1.5, headless: true, retry: true });
	try {
		await f.loop.submit("hello");
		await f.loop.whenSettled();
		strictEqual(f.wire.calls(), 0, "nothing reached the provider");
		const settled = JSON.stringify(f.events);
		match(
			settled,
			/budget_ceiling: session priced spend \$1\.50 reached the \$1\.50 ceiling with ~[\d,]+ context tokens per call/u,
		);
		doesNotMatch(settled, /stalled|"type":"retry_status"/u);
	} finally {
		f.loop.dispose();
		f.wire.dispose();
		await f.loop.whenSettled();
	}
});
