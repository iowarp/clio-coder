import { deepStrictEqual, match, rejects, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import llamacpp from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import {
	analyzeVision,
	createVisionSidecar,
	visionObservationText,
} from "../../src/domains/providers/vision-sidecar.js";

const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
const binding = {
	targetId: "vision",
	model: "MiniCPM-V-4.6-Q4_K_M",
	url: "http://127.0.0.1:8081",
	apiKey: "fixture-key",
};

it("sends images only to the bound sidecar and validates its structured answer", async () => {
	let request: Record<string, unknown> = {};
	let requestUrl = "";
	const fetchImpl: typeof fetch = async (url, init) => {
		requestUrl = String(url);
		request = JSON.parse(String(init?.body)) as Record<string, unknown>;
		strictEqual(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
		return Response.json({
			choices: [
				{ message: { content: JSON.stringify({ images: [{ index: 1, description: "A red square" }], answer: "red" }) } },
			],
		});
	};
	const result = await analyzeVision(binding, [image], "What color is it?", { fetchImpl });
	strictEqual(requestUrl, "http://127.0.0.1:8081/v1/chat/completions");
	strictEqual(request.model, binding.model);
	deepStrictEqual((request.response_format as { type: string }).type, "json_object");
	const messages = request.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
	strictEqual(messages[1]?.content[1]?.image_url?.url, "data:image/png;base64,aGVsbG8=");
	deepStrictEqual(result, {
		target: "vision",
		model: "MiniCPM-V-4.6-Q4_K_M",
		images: [{ index: 1, description: "A red square" }],
		answer: "red",
	});
	match(visionObservationText(result), /untrusted image observation.*MiniCPM-V-4\.6-Q4_K_M/su);
});

it("refuses malformed image data and malformed model output", async () => {
	let calls = 0;
	const fetchImpl: typeof fetch = async () => {
		calls += 1;
		return Response.json({ choices: [{ message: { content: "No JSON here" } }] });
	};
	await rejects(analyzeVision(binding, [{ ...image, data: "bad!" }], "Describe", { fetchImpl }), /base64/u);
	strictEqual(calls, 0);
	await rejects(analyzeVision(binding, [image], "Describe", { fetchImpl }), /structured answer/u);
	strictEqual(calls, 1);
});

it("does not confuse a sidecar failure with permission to send images to the main model", async () => {
	const fetchImpl: typeof fetch = async () => new Response("unavailable", { status: 503 });
	await rejects(analyzeVision(binding, [image], "Describe", { fetchImpl }), /HTTP 503/u);
});

it("binds fleet.profiles.vision to a separate llama.cpp target and fails closed when its vision flag is absent", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target = {
		id: "mini-vision",
		runtime: "llamacpp",
		url: "http://127.0.0.1:8081",
		defaultModel: "MiniCPM-V-4_6-Q4_K_M.gguf",
		capabilities: { chat: true, vision: true, contextWindow: 8192, maxTokens: 1024 },
	};
	settings.targets.push(target);
	settings.fleet.profiles.vision = { target: target.id, model: target.defaultModel, thinkingLevel: "off" };
	const providers = {
		getTarget: (id: string) => (id === target.id ? target : null),
		getRuntime: (id: string) => (id === "llamacpp" ? llamacpp : null),
		getDetectedReasoning: () => null,
		knowledgeBase: null,
		list: () => [
			{
				target,
				runtime: llamacpp,
				available: true,
				reason: "fixture",
				health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
				capabilities: { ...llamacpp.defaultCapabilities, ...target.capabilities },
				discoveredModels: [target.defaultModel],
			},
		],
	} as unknown as ProvidersContract;
	let requests = 0;
	const sidecar = createVisionSidecar({
		getSettings: () => settings,
		providers,
		fetchImpl: async () => {
			requests += 1;
			return Response.json({
				choices: [{ message: { content: '{"images":[{"index":1,"description":"a pixel"}],"answer":"one"}' } }],
			});
		},
	});
	strictEqual(sidecar.configured(), true);
	strictEqual(sidecar.label(), target.defaultModel);
	strictEqual((await sidecar.analyze([image], "Count")).answer, "one");
	strictEqual(requests, 1);
	target.capabilities.vision = false;
	await rejects(sidecar.analyze([image], "Count"), /vision|image input/iu);
	strictEqual(requests, 1);
});

it("probes an unprobed vision target once before resolving it, so a fresh headless process can use it", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target = { id: "mini-vision", runtime: "llamacpp", url: "http://127.0.0.1:8081", defaultModel: "minicpm" };
	settings.targets.push(target);
	settings.fleet.profiles.vision = { target: target.id, model: target.defaultModel, thinkingLevel: "off" };
	const status = {
		target,
		runtime: llamacpp,
		available: true,
		reason: "fixture",
		health: {
			status: "unknown",
			lastCheckAt: null as string | null,
			lastError: null,
			latencyMs: null as number | null,
		},
		capabilities: { ...llamacpp.defaultCapabilities },
		discoveredModels: [target.defaultModel],
	};
	let probes = 0;
	let probedVision = true;
	const providers = {
		getTarget: (id: string) => (id === target.id ? target : null),
		getRuntime: (id: string) => (id === "llamacpp" ? llamacpp : null),
		getDetectedReasoning: () => null,
		knowledgeBase: null,
		list: () => [status],
		probeTarget: async (id: string) => {
			probes += 1;
			strictEqual(id, target.id);
			status.health = { status: "healthy", lastCheckAt: "2026-09-24T00:00:00.000Z", lastError: null, latencyMs: 1 };
			status.capabilities = { ...status.capabilities, vision: probedVision };
			return status;
		},
	} as unknown as ProvidersContract;
	let requests = 0;
	const sidecar = createVisionSidecar({
		getSettings: () => settings,
		providers,
		fetchImpl: async () => {
			requests += 1;
			return Response.json({
				choices: [{ message: { content: '{"images":[{"index":1,"description":"x"}],"answer":"ok"}' } }],
			});
		},
	});
	strictEqual((await sidecar.analyze([image], "Describe")).answer, "ok");
	strictEqual((await sidecar.analyze([image], "Describe")).answer, "ok");
	strictEqual(probes, 1, "a probed target is not probed again");
	strictEqual(requests, 2);

	status.health = { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null };
	status.capabilities = { ...llamacpp.defaultCapabilities };
	probedVision = false;
	await rejects(sidecar.analyze([image], "Describe"), /vision|image input/iu);
	strictEqual(requests, 2, "a target that reports no image input gets no request");
});
