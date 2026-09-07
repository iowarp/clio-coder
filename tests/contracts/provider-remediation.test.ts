import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isRetryableErrorMessage } from "../../src/domains/session/retry.js";
import { engineStream, engineStreamSimple } from "../../src/engine/api-registry.js";
import { patchToolChoiceNamedPayload } from "../../src/engine/provider-payload.js";
import type { EngineModel } from "../../src/engine/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const model: EngineModel = {
	id: "claude-fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};

test("Anthropic named-tool rounds retain the entire tool prefix and resume thinking later", () => {
	const tools = [
		{ name: "read", input_schema: { type: "object" } },
		{ name: "bash", input_schema: { type: "object" } },
	];
	const payload = {
		tools,
		thinking: { type: "adaptive" },
		output_config: { effort: "high", format: { type: "json_schema" } },
	};
	const before = JSON.stringify(payload);
	const patched = patchToolChoiceNamedPayload(payload, model, "read") as Record<string, unknown>;
	assert.equal(patched.tools, tools);
	assert.equal(JSON.stringify(patched.tools), JSON.stringify(tools));
	assert.deepEqual(patched.tool_choice, { type: "tool", name: "read" });
	assert.equal(patched.thinking, undefined);
	assert.deepEqual(patched.output_config, { format: { type: "json_schema" } });
	assert.equal(JSON.stringify(payload), before);
	assert.equal(patchToolChoiceNamedPayload(payload, model, "missing"), undefined);
	const local = patchToolChoiceNamedPayload(payload, { ...model, api: "openai-completions" }, "read") as Record<
		string,
		unknown
	>;
	assert.deepEqual(local.tools, [tools[0]]);
	assert.equal(local.tool_choice, "required");
});

function anthropicResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "message-fixture",
				type: "message",
				role: "assistant",
				model: model.id,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

test("unsupported thinking 400 is terminal, not three identical transient retries", async () => {
	const env = await isolateClioEnv("provider-thinking-");
	try {
		let calls = 0;
		const result = await engineStreamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				apiKey: "fixture-key",
				reasoning: "high",
				fetch: async () => {
					calls++;
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "thinking.type.enabled is not supported" },
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				},
			},
		).result();
		assert.equal(calls, 1);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /thinking/u);
		assert.equal(isRetryableErrorMessage(result.errorMessage), false);
		assert.equal(isRetryableErrorMessage("400 thinking.type.adaptive is not supported"), false);
		assert.equal(isRetryableErrorMessage("429 rate limit exceeded"), true);
	} finally {
		env.restore();
	}
});

test("operator Anthropic cache retention reaches both central stream paths and honors compat", async () => {
	const env = await isolateClioEnv("provider-retention-");
	try {
		delete process.env.PI_CACHE_RETENTION;
		const sent: Record<string, unknown>[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)));
			return anthropicResponse();
		};
		for (const stream of [engineStream, engineStreamSimple]) {
			process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION = "long";
			const result = await stream(
				model,
				{ systemPrompt: "cacheable system", messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				{ apiKey: "fixture-key", fetch },
			).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.match(JSON.stringify(sent.at(-1)), /"ttl":"1h"/u);
			delete process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
			await stream(model, { systemPrompt: "cacheable system", messages: [] }, { apiKey: "fixture-key", fetch }).result();
			assert.doesNotMatch(JSON.stringify(sent.at(-1)), /"ttl"/u);
			process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION = "long";
			await stream(
				{ ...model, compat: { supportsLongCacheRetention: false } },
				{ systemPrompt: "cacheable system", messages: [] },
				{ apiKey: "fixture-key", fetch },
			).result();
			assert.doesNotMatch(JSON.stringify(sent.at(-1)), /"ttl"/u);
			await stream(
				model,
				{ systemPrompt: "cacheable system", messages: [] },
				{ apiKey: "fixture-key", fetch, cacheRetention: "none" },
			).result();
			assert.doesNotMatch(JSON.stringify(sent.at(-1)), /"cache_control"/u);
		}
	} finally {
		env.restore();
	}
});

test("provider dump composes async payload mutations and preserves every stream event", async (t) => {
	const env = await isolateClioEnv("provider-dump-");
	t.mock.method(Date, "now", () => 1000);
	try {
		const path = join(env.dir, "wire.jsonl");
		const sent: unknown[] = [];
		let mutations = 0;
		const options = {
			apiKey: "fixture-secret-provider-key",
			headers: { Authorization: "Bearer fixture-secret-header" },
			fetch: async (_input: unknown, init?: RequestInit) => {
				sent.push(JSON.parse(String(init?.body)));
				return anthropicResponse();
			},
			onPayload: async (payload: unknown) => {
				await Promise.resolve();
				mutations++;
				return { ...(payload as object), max_tokens: 77 };
			},
		};
		const run = async () => {
			const stream = engineStreamSimple(
				model,
				{ systemPrompt: "Inspect this system prompt", messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				options,
			);
			const events: unknown[] = [];
			for await (const event of stream) events.push(structuredClone(event));
			const response = await stream.result();
			return { events, response };
		};
		delete process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
		const baseline = await run();
		assert.equal(existsSync(path), false);
		process.env.CLIO_CODER_PROVIDER_DUMP_PATH = path;
		const captured = await run();
		assert.equal(mutations, 2);
		assert.equal(
			JSON.stringify(captured),
			JSON.stringify(baseline),
			"diagnostics must not change events persisted by ledger consumers",
		);
		const raw = readFileSync(path, "utf8");
		const lines = raw.trim().split("\n");
		assert.equal(lines.length, 1);
		const record = JSON.parse(lines[0] ?? "");
		assert.deepEqual(record.payloads, [sent[1]]);
		assert.deepEqual(record.response, captured.response);
		assert.equal(record.payloads[0].max_tokens, 77);
		assert.doesNotMatch(raw, /fixture-secret-provider-key|fixture-secret-header|Authorization/u);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		await run();
		assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
	} finally {
		env.restore();
	}
});

test("provider dump refuses relative paths, existing public files, and symlink destinations", async () => {
	const env = await isolateClioEnv("provider-dump-path-");
	try {
		const publicPath = join(env.dir, "public.jsonl");
		writeFileSync(publicPath, "keep", { mode: 0o644 });
		const link = join(env.dir, "link.jsonl");
		symlinkSync(publicPath, link);
		let requests = 0;
		for (const path of ["relative.jsonl", publicPath, link]) {
			process.env.CLIO_CODER_PROVIDER_DUMP_PATH = path;
			assert.throws(() =>
				engineStreamSimple(
					model,
					{ messages: [] },
					{
						apiKey: "fixture",
						fetch: async () => {
							requests++;
							return anthropicResponse();
						},
					},
				),
			);
		}
		assert.equal(requests, 0);
		assert.equal(readFileSync(publicPath, "utf8"), "keep");
	} finally {
		env.restore();
	}
});

test("Anthropic cache environment does not alter non-Anthropic wire requests", async () => {
	const env = await isolateClioEnv("provider-cache-other-");
	try {
		delete process.env.PI_CACHE_RETENTION;
		const sent: unknown[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)));
			return new Response(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const other = {
			...model,
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			compat: { supportsLongCacheRetention: true },
		} as EngineModel;
		for (const stream of [engineStream, engineStreamSimple]) {
			delete process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
			const baseline = await stream(
				other,
				{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				{ apiKey: "fixture", sessionId: "cache-session", fetch },
			).result();
			assert.equal(baseline.stopReason, "stop", baseline.errorMessage);
			process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION = "long";
			const candidate = await stream(
				other,
				{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				{ apiKey: "fixture", sessionId: "cache-session", fetch },
			).result();
			assert.equal(candidate.stopReason, "stop", candidate.errorMessage);
			assert.deepEqual(sent.at(-1), sent.at(-2));
		}
	} finally {
		env.restore();
	}
});

test("diagnostics capture in-place callback changes and redact credential echoes only in the dump", async () => {
	const env = await isolateClioEnv("provider-dump-redaction-");
	try {
		const path = join(env.dir, "error.jsonl");
		process.env.CLIO_CODER_PROVIDER_DUMP_PATH = path;
		let body: Record<string, unknown> = {};
		const result = await engineStream(
			model,
			{ systemPrompt: "secret-provider-token", messages: [] },
			{
				apiKey: "secret-provider-token",
				headers: { "X-Auth": "custom-gateway-credential" },
				onPayload: async (payload) => {
					await Promise.resolve();
					(payload as Record<string, unknown>).max_tokens = 51;
				},
				fetch: async (_input, init) => {
					body = JSON.parse(String(init?.body));
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "bad secret-provider-token custom-gateway-credential" },
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				},
			},
		).result();
		assert.equal(body.max_tokens, 51);
		assert.match(JSON.stringify(body), /secret-provider-token/u);
		assert.match(result.errorMessage ?? "", /secret-provider-token/u);
		assert.match(result.errorMessage ?? "", /custom-gateway-credential/u);
		const raw = readFileSync(path, "utf8");
		assert.doesNotMatch(raw, /secret-provider-token|custom-gateway-credential/u);
		const record = JSON.parse(raw);
		assert.equal(record.payloads[0].max_tokens, 51);
		assert.equal(record.response.stopReason, "error");
		assert.match(record.response.errorMessage, /REDACTED/u);
	} finally {
		env.restore();
	}
});
