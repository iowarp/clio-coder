import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import {
	lmStudioReasoningEffort,
	lmStudioReasoningLevels,
} from "../../src/domains/providers/runtimes/common/lmstudio-http.js";
import lmstudioRuntime from "../../src/domains/providers/runtimes/local-native/lmstudio.js";
import type { ThinkingLevel } from "../../src/domains/providers/types/capability-flags.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { ensureLmStudioResidency } from "../../src/engine/apis/lmstudio.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { resetResidencyState, setResidencyNoticeSink } from "../../src/engine/apis/residency.js";
import { type FakeLmStudioFixture, startFakeLmStudioServer } from "../harness/fake-lmstudio-server.js";

const fixtures: FakeLmStudioFixture[] = [];
const probeContext: ProbeContext = { credentialsPresent: new Set<string>(), httpTimeoutMs: 2_000 };

afterEach(async () => {
	setResidencyNoticeSink(null);
	resetResidencyState();
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function fake(options: Parameters<typeof startFakeLmStudioServer>[0] = {}): Promise<FakeLmStudioFixture> {
	const fixture = await startFakeLmStudioServer(options);
	fixtures.push(fixture);
	return fixture;
}

function target(server: FakeLmStudioFixture, overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
	return {
		id: "studio",
		runtime: "lmstudio",
		url: server.url,
		defaultModel: "qwen3.8-27b-zbook",
		...overrides,
	};
}

function model(descriptor: TargetDescriptor): Model<"openai-completions"> {
	return lmstudioRuntime.synthesizeModel(
		descriptor,
		descriptor.defaultModel ?? "qwen3.8-27b",
		null,
	) as Model<"openai-completions">;
}

async function drainChat(
	descriptor: TargetDescriptor,
	options: Record<string, unknown> = {},
	context: Record<string, unknown> = { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
	chatModel: Model<"openai-completions"> = model(descriptor),
): Promise<Array<Record<string, unknown>>> {
	const events: Array<Record<string, unknown>> = [];
	const stream = openAICompletionsApiProvider.streamSimple(
		chatModel,
		context as unknown as Parameters<typeof openAICompletionsApiProvider.streamSimple>[1],
		{ apiKey: "lm-studio", ...options } as Parameters<typeof openAICompletionsApiProvider.streamSimple>[2],
	);
	for await (const event of stream) events.push(event as unknown as Record<string, unknown>);
	return events;
}

describe("contracts/lmstudio REST probe", () => {
	it("parses v1 keys, instance ids, load config, and model reasoning levels", async () => {
		const server = await fake();
		const result = await lmstudioRuntime.probe?.(target(server), probeContext);
		ok(result?.ok, result?.error);
		strictEqual(result.models?.includes("qwen3.8-27b"), false);
		ok(result.models?.includes("qwen3.8-27b-zbook"));
		ok(result.models?.includes("qwen3.8-27b-dynamo"));
		strictEqual(result.modelStates?.["qwen3.8-27b-zbook"]?.key, "qwen3.8-27b");
		strictEqual(result.modelStates?.["qwen3.8-27b-zbook"]?.instanceId, "qwen3.8-27b-zbook");
		strictEqual(result.modelStates?.["qwen3.8-27b-zbook"]?.contextLength, 262_144);
		strictEqual(result.modelStates?.["qwen3.8-27b-dynamo"]?.contextLength, 131_072);
		strictEqual(result.modelStates?.["qwen3.8-27b-zbook"]?.loadConfig?.speculative_draft_mtp, true);
		deepStrictEqual(result.modelStates?.["qwen3.8-27b-zbook"]?.reasoningLevels, ["off", "low"]);
		deepStrictEqual(result.modelStates?.["coder-unloaded"]?.reasoningLevels, ["off", "low"]);
		strictEqual(result.capabilityModelId, "qwen3.8-27b-zbook");
		strictEqual(result.discoveredCapabilities?.contextWindow, 262_144);
		deepStrictEqual(result.surfaces, {
			openaiChat: "/v1/chat/completions",
			nativeV1: "/api/v1/models",
		});
		deepStrictEqual(await lmstudioRuntime.probeModels?.(target(server), probeContext), result.models);
		strictEqual(server.requestsFor("/api/v1/models/unload").length, 0);
	});

	it("falls back to the v0 body when the missing v1 route returns HTTP 200 with an error", async () => {
		const server = await fake({ mode: "0.3" });
		const result = await lmstudioRuntime.probe?.(target(server, { defaultModel: "qwen3.8-27b-zbook" }), probeContext);
		ok(result?.ok, result?.error);
		strictEqual(result.serverVersion, "LM Studio API 0.3.x");
		ok(result.models?.includes("qwen3.8-27b-zbook"));
		strictEqual(server.requestsFor("/api/v1/models").length > 0, true);
		strictEqual(server.requestsFor("/api/v0/models").length > 0, true);
	});

	it("reports required authentication and sends one bearer to every protected route", async () => {
		const server = await fake({ authToken: "secret" });
		const without = await lmstudioRuntime.probe?.(target(server), probeContext);
		strictEqual(without?.ok, false);
		ok(without?.error?.includes("authentication required"), without?.error);
		server.requests.length = 0;
		const withToken = await lmstudioRuntime.probe?.(target(server), { ...probeContext, authToken: "secret" });
		ok(withToken?.ok, withToken?.error);
		for (const request of server.requests.filter((entry) => entry.path !== "/lmstudio-greeting")) {
			strictEqual(request.headers.authorization, "Bearer secret");
		}
	});

	it("resolves the legacy runtime id to the canonical descriptor object", () => {
		const registry = createRuntimeRegistry();
		registry.register(lmstudioRuntime);
		strictEqual(registry.get("lmstudio"), lmstudioRuntime);
		strictEqual(registry.get("lmstudio-native"), lmstudioRuntime);
		deepStrictEqual(registry.list(), [lmstudioRuntime]);
	});
});

describe("contracts/lmstudio reasoning and chat wire", () => {
	it("maps all seven Clio levels and clamps on-off model options", () => {
		const expected: Record<ThinkingLevel, string> = {
			off: "none",
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
			max: "high",
		};
		for (const [level, effort] of Object.entries(expected) as Array<[ThinkingLevel, string]>) {
			strictEqual(lmStudioReasoningEffort(level), effort);
			strictEqual(lmStudioReasoningEffort(level, ["off", "on"]), level === "off" ? "none" : "low");
		}
		deepStrictEqual(lmStudioReasoningLevels(["off", "on"]), ["off", "low"]);
	});

	it("keeps the server-default off state and ignores chat template thinking flags", async () => {
		const server = await fake();
		const descriptor = target(server);
		const events = await drainChat(descriptor);
		strictEqual(
			events.some((event) => event.type === "thinking_delta"),
			false,
		);
		const request = server.requestsFor("/v1/chat/completions").at(-1);
		strictEqual(request?.body?.reasoning_effort, "none");
		strictEqual("chat_template_kwargs" in (request?.body ?? {}), false);
		strictEqual(server.requestsFor("/api/v1/models/unload").length, 0);

		const ignored = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "qwen3.8-27b-zbook",
				messages: [{ role: "user", content: "hello" }],
				chat_template_kwargs: { enable_thinking: true },
			}),
		});
		strictEqual((await ignored.text()).includes('"reasoning"'), false);
	});

	it("sends ttl, draft model, and reasoning effort without chat template kwargs", async () => {
		const server = await fake();
		const descriptor = target(server, {
			lmstudio: { request: { ttlSeconds: 600, draftModel: "draft-model", reasoning: "auto" } },
		});
		const events = await drainChat(descriptor, { reasoning: "xhigh" });
		ok(events.some((event) => event.type === "thinking_delta"));
		ok(events.some((event) => event.type === "done"));
		const done = events.find((event) => event.type === "done") as
			| { message?: { usage?: { input?: number; output?: number; reasoningTokens?: number } } }
			| undefined;
		strictEqual(done?.message?.usage?.input, 6);
		strictEqual(done?.message?.usage?.output, 4);
		ok((done?.message?.usage?.reasoningTokens ?? 0) > 0);
		const request = server.requestsFor("/v1/chat/completions").at(-1);
		strictEqual(request?.body?.ttl, 600);
		strictEqual(request?.body?.draft_model, "draft-model");
		strictEqual(request?.body?.reasoning_effort, "low");
		strictEqual("chat_template_kwargs" in (request?.body ?? {}), false);
	});

	it("keeps an explicit LM Studio reasoning override above the resolved dial", async () => {
		const server = await fake();
		const descriptor = target(server, {
			defaultModel: "coder-unloaded",
			lmstudio: { request: { reasoning: "high" } },
		});
		const probe = await lmstudioRuntime.probe?.(descriptor, probeContext);
		ok(probe?.ok, probe?.error);
		await drainChat(descriptor, { reasoning: "xhigh" });
		const request = server.requestsFor("/v1/chat/completions").at(-1);
		strictEqual(request?.body?.reasoning_effort, "high");
	});

	it("maps every documented LM Studio reasoning override onto the resolved effort", async () => {
		const cases = [
			["auto", "low"],
			["off", "none"],
			["on", "low"],
			["low", "low"],
			["medium", "medium"],
			["high", "high"],
		] as const;
		for (const [reasoning, expected] of cases) {
			const server = await fake();
			const descriptor = target(server, { lmstudio: { request: { reasoning } } });
			await drainChat(descriptor, { reasoning: "xhigh" });
			strictEqual(server.requestsFor("/v1/chat/completions").at(-1)?.body?.reasoning_effort, expected, reasoning);
		}
	});

	it("keeps the resolver effort map authoritative for LM Studio payloads", async () => {
		const server = await fake();
		const descriptor = target(server);
		const configured = model(descriptor) as Model<"openai-completions"> & {
			clio?: { quirks?: { thinking: Record<string, unknown> } };
		};
		if (configured.clio) {
			configured.clio.quirks = {
				thinking: {
					mechanism: "effort-levels",
					effortByLevel: { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" },
				},
			};
		}
		await drainChat(descriptor, { reasoning: "high" }, undefined, configured);
		strictEqual(server.requestsFor("/v1/chat/completions").at(-1)?.body?.reasoning_effort, "xhigh");
	});

	it("does not add an LM Studio effort for none or always-on mechanisms", async () => {
		for (const mechanism of ["none", "always-on"] as const) {
			const server = await fake();
			const descriptor = target(server);
			const configured = model(descriptor) as Model<"openai-completions"> & {
				clio?: { quirks?: { thinking: Record<string, unknown> } };
			};
			if (configured.clio) configured.clio.quirks = { thinking: { mechanism } };
			await drainChat(descriptor, mechanism === "none" ? { reasoning: "high" } : {}, undefined, configured);
			strictEqual("reasoning_effort" in (server.requestsFor("/v1/chat/completions").at(-1)?.body ?? {}), false);
		}
	});

	it("assembles a split tool call from the scripted SSE response", async () => {
		const server = await fake();
		const descriptor = target(server);
		const context = {
			messages: [{ role: "user", content: "weather", timestamp: 0 }],
			tools: [
				{
					name: "get_weather",
					description: "Get weather",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			],
		};
		const events = await drainChat(descriptor, { reasoning: "low" }, context);
		const toolEnd = events.find((event) => event.type === "toolcall_end") as
			| { toolCall?: { name?: string; arguments?: Record<string, unknown> } }
			| undefined;
		strictEqual(toolEnd?.toolCall?.name, "get_weather");
		deepStrictEqual(toolEnd?.toolCall?.arguments, { city: "Chicago" });
	});
});

describe("contracts/lmstudio REST residency", () => {
	it("uses server JIT defaults when no explicit load setting exists", async () => {
		const server = await fake();
		const descriptor = target(server, { defaultModel: "coder-unloaded" });
		await ensureLmStudioResidency(model(descriptor), { apiKey: "lm-studio" });
		strictEqual(server.requestsFor("/api/v1/models/load").length, 0);
	});

	it("loads once with only explicit fields and carries bearer auth", async () => {
		const server = await fake({ authToken: "secret" });
		const descriptor = target(server, {
			defaultModel: "coder-unloaded",
			lmstudio: {
				load: {
					contextLength: 32_768,
					flashAttention: false,
					evalBatchSize: 512,
					numExperts: 8,
					offloadKvCacheToGpu: true,
				},
			},
		});
		await ensureLmStudioResidency(model(descriptor), { apiKey: "secret" });
		const load = server.requestsFor("/api/v1/models/load");
		strictEqual(load.length, 1);
		deepStrictEqual(load[0]?.body, {
			model: "coder-unloaded",
			echo_load_config: true,
			context_length: 32_768,
			flash_attention: false,
			eval_batch_size: 512,
			num_experts: 8,
			offload_kv_cache_to_gpu: true,
		});
		strictEqual(load[0]?.headers.authorization, "Bearer secret");
	});

	it("treats local and LM Link same-key instances as observe-only during reconcile", async () => {
		const server = await fake({ authToken: "secret" });
		const descriptor = target(server, {
			defaultModel: "qwen3.8-27b-zbook",
			lmstudio: { load: { contextLength: 262_144 } },
		});
		await ensureLmStudioResidency(model(descriptor), { apiKey: "secret" });
		strictEqual(server.requestsFor("/api/v1/models/load").length, 0);
		strictEqual(server.requestsFor("/api/v1/models/unload").length, 0);
	});

	it("retries a failed explicit load without releasing pre-existing instances", async () => {
		const server = await fake({ failLoads: 1 });
		const descriptor = target(server, {
			defaultModel: "coder-unloaded",
			lmstudio: { load: { contextLength: 32_768 } },
		});
		await ensureLmStudioResidency(model(descriptor));
		strictEqual(server.requestsFor("/api/v1/models/load").length, 2);
		strictEqual(server.requestsFor("/api/v1/models/unload").length, 0);
	});

	it("releases only an instance loaded by this adapter process", async () => {
		const server = await fake();
		const first = target(server, {
			defaultModel: "coder-unloaded",
			lmstudio: { load: { contextLength: 32_768 } },
		});
		await ensureLmStudioResidency(model(first));
		server.failNextLoads();
		const second = target(server, {
			defaultModel: "embedding-model",
			lmstudio: { load: { contextLength: 4096 } },
		});
		await ensureLmStudioResidency(model(second));
		deepStrictEqual(
			server.requestsFor("/api/v1/models/unload").map((request) => request.body?.instance_id),
			["coder-unloaded:clio"],
		);
	});

	it("keeps older v0 servers observe-only even with load settings", async () => {
		const server = await fake({ mode: "0.3" });
		const descriptor = target(server, {
			defaultModel: "coder-unloaded",
			lmstudio: { load: { contextLength: 32_768 } },
		});
		await ensureLmStudioResidency(model(descriptor));
		strictEqual(server.requestsFor("/api/v1/models/load").length, 0);
		strictEqual(server.requestsFor("/api/v1/models/unload").length, 0);
	});
});
