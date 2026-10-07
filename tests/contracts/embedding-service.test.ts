import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import {
	createEmbeddingService,
	EmbeddingError,
	embeddingGemma2Q8Profile,
	embeddingProfileIdentity,
} from "../../src/domains/providers/embedding/index.js";
import { canonicalEndpointKey, registerForegroundStream } from "../../src/domains/providers/endpoint-capacity.js";

it("embeds ordered typed modalities, prefixes text and isolates exact profile recipes", async (t) => {
	const bodies: Array<{ input: unknown[] }> = [];
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		const body = JSON.parse(text);
		bodies.push(body);
		res.end(
			JSON.stringify({
				model: "gemma",
				data: body.input.map((_: unknown, index: number) => ({ index, embedding: [3, 4] })).reverse(),
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const target = {
		id: "fixture",
		runtime: "litellm",
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
	const service = createEmbeddingService({
		route: { target, model: "gemma", modalities: ["text", "image", "audio", "mixed"] },
	});
	const profile = { ...embeddingGemma2Q8Profile({ model: "gemma", assetIdentity: "sha256:fixture" }), dimensions: 2 };
	const image = { kind: "image", mimeType: "image/png", data: "YWJj" } as const;
	const audio = { kind: "audio", mimeType: "audio/wav", data: "YWJj" } as const;
	const output = await service.embed({
		profile,
		task: "query",
		inputs: [
			{ kind: "text", text: "find" },
			image,
			audio,
			{ kind: "mixed", parts: [image, { kind: "text", text: "describe" }, audio] },
		],
	});
	assert.deepEqual(output.vectors, [
		[0.6, 0.8],
		[0.6, 0.8],
		[0.6, 0.8],
		[0.6, 0.8],
	]);
	assert.deepEqual(bodies[0]?.input, [
		"task: search result | query: find",
		{ content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }] },
		{ content: [{ type: "input_audio", input_audio: { data: "YWJj", format: "wav" } }] },
		{
			content: [
				{ type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
				{ type: "text", text: "task: search result | query: describe" },
				{ type: "input_audio", input_audio: { data: "YWJj", format: "wav" } },
			],
		},
	]);
	await service.embed({ profile, task: "document", inputs: [{ kind: "text", text: "find" }] });
	assert.equal(bodies[1]?.input[0], "title: none | text: find");
	assert.notEqual(
		embeddingProfileIdentity(profile),
		embeddingProfileIdentity({ ...profile, assetIdentity: "different" }),
	);
	await assert.rejects(
		service.embed({ profile, task: "query", inputs: [{ kind: "video", data: "YWJj", mimeType: "video/mp4" }] }),
		(e: unknown) => e instanceof EmbeddingError && e.code === "unsupported",
	);
	await assert.rejects(service.embed({ profile, task: "query", inputs: [{ ...image, data: "bad!" }] }), /base64/);
	const release = registerForegroundStream(canonicalEndpointKey(target) ?? "invalid");
	await assert.rejects(
		service.embed({ profile, task: "query", priority: "background", inputs: [{ kind: "text", text: "find" }] }),
		(e: unknown) => e instanceof EmbeddingError && e.code === "paused",
	);
	release();
	assert.equal(bodies.length, 2);
});

it("rejects malformed responses and cancels transport without retrying", async (t) => {
	let reply: unknown = { model: "wrong", data: [{ index: 0, embedding: [3, 4] }] };
	let hold = false;
	let calls = 0;
	let arrived: (() => void) | undefined;
	const server = createServer((_req, res) => {
		calls++;
		arrived?.();
		if (!hold) res.end(JSON.stringify(reply));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const target = {
		id: "fixture",
		runtime: "llamacpp-embed",
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
	const service = createEmbeddingService({ route: { target, model: "gemma", modalities: ["text"] } });
	const profile = { ...embeddingGemma2Q8Profile({ model: "gemma", assetIdentity: "fixture" }), dimensions: 2 };
	const request = { profile, task: "query", inputs: [{ kind: "text", text: "find" }] } as const;
	await assert.rejects(service.embed(request), /differs/);
	for (const vector of [[0, 0], [1], [1, null], [1, "NaN"]]) {
		reply = { model: "gemma", data: [{ index: 0, embedding: vector }] };
		await assert.rejects(
			service.embed(request),
			(e: unknown) => e instanceof EmbeddingError && e.code === "invalid-response",
		);
	}
	reply = { model: "gemma", data: [{ index: 1, embedding: [1, 2] }] };
	await assert.rejects(service.embed(request), /indices/);
	hold = true;
	const controller = new AbortController();
	const received = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const pending = service.embed({ ...request, signal: controller.signal });
	await received;
	controller.abort();
	await assert.rejects(pending, (e: unknown) => e instanceof EmbeddingError && e.code === "cancelled");
	await assert.rejects(
		service.embed({ ...request, timeoutMs: 20 }),
		(e: unknown) => e instanceof EmbeddingError && e.code === "timeout",
	);
	const started = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const background = service.embed({ ...request, priority: "background" });
	await started;
	const release = registerForegroundStream(canonicalEndpointKey(target) ?? "invalid");
	await assert.rejects(background, (e: unknown) => e instanceof EmbeddingError && e.code === "paused");
	release();
	assert.equal(calls, 9);
});
