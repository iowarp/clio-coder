import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import inception from "../../src/domains/providers/runtimes/cloud/inception.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 5000, authToken: "test-key" };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Captured {
	url: string;
	body: unknown;
	headers: Record<string, string>;
}

/** Stub global fetch with a fixed reply, recording what the runtime sent. */
function stubFetch(reply: () => Response): Captured {
	const captured: Captured = { url: "", body: null, headers: {} };
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		captured.url = String(input);
		captured.headers = (init?.headers ?? {}) as Record<string, string>;
		if (typeof init?.body === "string") captured.body = JSON.parse(init.body);
		return reply();
	}) as typeof fetch;
	return captured;
}

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

const inceptionTarget: TargetDescriptor = { id: "mercury", runtime: "inception", defaultModel: "mercury-edit-2" };

describe("inception", () => {
	it("streams FIM completions into chunks", async () => {
		const frames = [
			{ choices: [{ index: 0, text: "f", finish_reason: null }] },
			{ choices: [{ index: 0, text: "ib", finish_reason: null }] },
			{ choices: [{ index: 0, text: "(n-1)", finish_reason: "stop" }] },
		];
		const captured = stubFetch(
			() =>
				new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
		);

		const chunks: string[] = [];
		let stopped = false;
		for await (const chunk of inception.infill?.(
			inceptionTarget,
			{ prompt: "", input_prefix: "def fib(n): return ", input_suffix: "\n", n_predict: 40 },
			ctx,
		) ?? []) {
			chunks.push(chunk.content);
			if (chunk.stop) stopped = true;
		}
		strictEqual(chunks.join(""), "fib(n-1)");
		ok(stopped);

		strictEqual(captured.url, "https://api.inceptionlabs.ai/v1/fim/completions");
		const body = captured.body as { model: string; prompt: string; suffix: string; max_tokens: number; stream: boolean };
		strictEqual(body.model, "mercury-edit-2");
		strictEqual(body.prompt, "def fib(n): return ");
		strictEqual(body.suffix, "\n");
		strictEqual(body.max_tokens, 40);
		strictEqual(body.stream, true);
	});

	it("maps a length stop to a limit chunk", async () => {
		stubFetch(
			() =>
				new Response(`data: ${JSON.stringify({ choices: [{ text: "x", finish_reason: "length" }] })}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const seen = [];
		for await (const chunk of inception.infill?.(
			inceptionTarget,
			{ prompt: "", input_prefix: "a", input_suffix: "b" },
			ctx,
		) ?? []) {
			seen.push(chunk);
		}
		strictEqual(seen.at(-1)?.stop_type, "limit");
	});

	it("surfaces a FIM transport failure", async () => {
		stubFetch(() => new Response("nope", { status: 502, statusText: "Bad Gateway" }));
		await rejects(async () => {
			for await (const _ of inception.infill?.(
				inceptionTarget,
				{ prompt: "", input_prefix: "a", input_suffix: "b" },
				ctx,
			) ?? []) {
				// consuming the stream is what triggers the request
			}
		}, /Inception FIM failed: HTTP 502/);
	});

	it("reads per-model windows off the catalog probe", async () => {
		stubFetch(() =>
			json({
				data: [
					{ id: "mercury-2.5", name: "Inception: Mercury 2.5", context_length: 260000, max_output_length: 65536 },
					{ id: "mercury-edit-2", name: "Inception: Mercury Edit 2", context_length: 128000, max_output_length: 32000 },
				],
			}),
		);
		const result = await inception.probe?.(inceptionTarget, ctx);
		ok(result?.ok);
		deepStrictEqual(result.models, ["mercury-2.5", "mercury-edit-2"]);
		strictEqual(result.modelCapabilities?.["mercury-2.5"]?.contextWindow, 260000);
		strictEqual(result.modelCapabilities?.["mercury-edit-2"]?.maxTokens, 32000);
	});

	it("fails the probe when the configured model is absent", async () => {
		stubFetch(() => json({ data: [{ id: "mercury-2" }] }));
		const result = await inception.probe?.(inceptionTarget, ctx);
		strictEqual(result?.ok, false);
		match(result?.error ?? "", /mercury-edit-2/);
	});
});
