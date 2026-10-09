import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { getCatalogModelForRuntime } from "../../src/domains/providers/catalog.js";
import { isRetryableErrorMessage } from "../../src/domains/session/retry.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { engineStream, engineStreamSimple } from "../../src/engine/api-registry.js";
import { PREWARM_USER_TEXT, runPrewarmRound } from "../../src/engine/prewarm.js";
import { applyToolRounds, type ToolRound } from "../../src/engine/provider-payload.js";
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

test("Anthropic named-tool rounds retain the entire tool prefix and resume thinking later", async () => {
	const tools = ["read", "bash"].map((name) => ({ name, description: name, parameters: Type.Object({}) }));
	// Managed-effort Claude: Pi sends adaptive thinking and effort whatever `reasoning` says.
	const managed = {
		...model,
		id: "claude-opus-5",
		compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
	} as EngineModel;
	const request = { messages: [{ role: "user" as const, content: "go", timestamp: 0 }], tools };
	type Body = {
		tools: Array<{ name: string }>;
		tool_choice?: unknown;
		thinking?: { type: string; budget_tokens?: number };
		temperature?: number;
		output_config?: { effort?: string };
	};
	const wire = async (target: EngineModel, rounds: readonly ToolRound[]): Promise<Body> => {
		const controlled = applyToolRounds(
			target,
			request,
			{ apiKey: "fixture", reasoning: "high", temperature: 0.2 },
			rounds,
		);
		let body: Body | undefined;
		await engineStreamSimple(target, controlled.context, {
			...controlled.options,
			onPayload: async (payload, current) => {
				body = structuredClone((await controlled.options?.onPayload?.(payload, current)) ?? payload) as Body;
				throw new Error("captured before network I/O");
			},
		}).result();
		assert.ok(body, "the serializer must build a body before the stream fails");
		return body;
	};
	const forced = await wire(managed, [{ kind: "required", toolName: "read" }]);
	// Pi 1.0 appends a reserved deferred placeholder to managed-tool Claude requests.
	assert.deepEqual(
		forced.tools.map((entry) => entry.name).filter((entry) => !entry.startsWith("__pi_")),
		["read", "bash"],
	);
	assert.deepEqual(forced.tool_choice, { type: "tool", name: "read" });
	assert.equal(forced.thinking, undefined);
	assert.equal(forced.output_config?.effort, undefined);
	// The next round without a forced choice resumes the configured thinking.
	const resumed = await wire(managed, []);
	assert.equal(resumed.thinking?.type, "adaptive");
	assert.equal(resumed.output_config?.effort, "high");
	assert.equal(resumed.tool_choice, undefined);
	const haiku = getCatalogModelForRuntime("anthropic", "claude-haiku-5-5");
	assert.ok(haiku);
	const adaptive = await wire(haiku, []);
	assert.equal(adaptive.thinking?.type, "adaptive");
	assert.equal(adaptive.thinking?.budget_tokens, undefined);
	assert.equal(adaptive.output_config?.effort, "high");
	assert.equal(adaptive.temperature, undefined);
	const forcedHaiku = await wire(haiku, [{ kind: "required", toolName: "read" }]);
	assert.deepEqual(forcedHaiku.tool_choice, { type: "tool", name: "read" });
	assert.equal(forcedHaiku.thinking, undefined);
	const missing = applyToolRounds(managed, request, undefined, [{ kind: "required", toolName: "missing" }]);
	assert.equal(missing.context, request);
	assert.equal(missing.options, undefined);
	const local = applyToolRounds({ ...model, api: "openai-completions" } as EngineModel, request, undefined, [
		{ kind: "required", toolName: "read" },
	]);
	assert.deepEqual(
		local.context.tools?.map((entry) => entry.name),
		["read"],
	);
	assert.equal(local.options?.toolChoice, "required");
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
		const headers: Headers[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)));
			headers.push(new Headers(init?.headers));
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
		const haiku = getCatalogModelForRuntime("anthropic", "claude-haiku-5-5");
		assert.ok(haiku);
		const { agent } = createEngineAgent({
			initialState: {
				model: haiku,
				thinkingLevel: "high",
				systemPrompt: "cacheable system",
				messages: [{ role: "user", content: "retained context", timestamp: 0 }],
				tools: [
					{
						name: "inspect",
						label: "Inspect",
						description: "Original paths",
						parameters: Type.Object({}),
						execute: async () => {
							throw new Error("warm and text-only response must not execute tools");
						},
					},
				],
			},
			getApiKey: () => "fixture-key",
			transcriptStreamFn: (current, context, options) => engineStreamSimple(current, context, { ...options, fetch }),
		});
		agent.state.tools = agent.state.tools.map((tool) => ({ ...tool, description: "Updated paths" }));
		const warm = await runPrewarmRound({ model: haiku, state: agent.state, agent, apiKey: "fixture-key" });
		assert.equal(warm.errorMessage, null);
		await agent.prompt("Actual task suffix");
		const [warmed, actual] = sent.slice(-2);
		assert.ok(warmed && actual);
		assert.equal(warmed.max_tokens, 1);
		assert.deepEqual(warmed.system, actual.system);
		assert.deepEqual(warmed.tools, actual.tools);
		assert.deepEqual(
			warmed.messages,
			JSON.parse(JSON.stringify(actual.messages).replaceAll("Actual task suffix", PREWARM_USER_TEXT)),
		);
		for (const request of [warmed, actual]) {
			const messages = request.messages as Array<{
				content: Array<{ type: string; tool?: { type: string; definition?: { name: string; description: string } } }>;
			}>;
			const changes = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
			const addition = changes.find((block) => block.type === "tool_addition");
			assert.equal(addition?.tool?.type, "tool_definition");
			assert.equal(addition?.tool?.definition?.name, "inspect");
			assert.equal(addition?.tool?.definition?.description, "Updated paths");
			assert.equal(
				changes.some((block) => block.type === "tool_removal"),
				false,
			);
		}
		for (const header of headers.slice(-2)) {
			assert.ok(header.get("anthropic-beta")?.split(",").includes("inline-tools-2026-09-15"));
			assert.equal(header.get("anthropic-beta")?.includes("mid-conversation-tool-changes-2026-07-01"), false);
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
		assert.deepEqual(record.response.content, captured.response.content);
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
			const result = await engineStreamSimple(
				model,
				{ messages: [] },
				{
					apiKey: "fixture",
					fetch: async () => {
						requests++;
						return anthropicResponse();
					},
				},
			).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /absolute file path|operator-owned regular file|ELOOP/u);
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
