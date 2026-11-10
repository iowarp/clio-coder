import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { cleanupEngineSessionResources, streamSimple } from "../../src/engine/ai.js";
import type { EngineModel } from "../../src/engine/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

type Context = Parameters<typeof streamSimple>[1];
type Body = {
	messages: unknown[];
	system?: unknown;
	tools?: Array<{ strict?: boolean }>;
	thread?: Record<string, unknown>;
};

test("idle threads restart once with full context, without disturbing warm requests or keepalives", async (t) => {
	const env = await isolateClioEnv("clio-thread-idle-");
	t.after(() => env.restore());
	delete process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
	let monotonic = 0;
	let wall = 1_000_000;
	t.mock.method(performance, "now", () => monotonic);
	t.mock.method(Date, "now", () => wall);
	const bodies: Body[] = [];
	const headers: Headers[] = [];
	const serverReplies = new Map<string, { monotonic: number; wall: number }>();
	let rejectNext: "expired" | "unsupported" | "failed" | "strict" | undefined;
	const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const body = JSON.parse(String(init?.body)) as Body;
		bodies.push(body);
		headers.push(new Headers(init?.headers));
		const previousId = body.thread?.previous_message_id;
		const previous = typeof previousId === "string" ? serverReplies.get(previousId) : undefined;
		if (
			!rejectNext &&
			body.thread?.type === "continue" &&
			(!previous || monotonic - previous.monotonic >= 300_000 || wall - previous.wall >= 300_000)
		) {
			rejectNext = "expired";
		}
		if (rejectNext) {
			const rejection = rejectNext;
			rejectNext = undefined;
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: rejection === "expired" ? "not_found_error" : "invalid_request_error",
						message: rejection === "strict" ? "The compiled grammar is too large" : rejection,
						details: {
							error_code:
								rejection === "expired"
									? "thread_not_found"
									: rejection === "failed" || rejection === "strict"
										? "overloaded"
										: "thread_unsupported_request",
						},
					},
				}),
				{
					status: rejection === "expired" ? 404 : rejection === "failed" ? 503 : 400,
					headers: { "content-type": "application/json", "retry-after-ms": "0" },
				},
			);
		}
		const id = `msg_${bodies.length}`;
		serverReplies.set(id, { monotonic, wall });
		const events = [
			{
				type: "message_start",
				message: {
					id,
					model: "claude-fixture",
					role: "assistant",
					type: "message",
					content: [],
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `reply ${bodies.length}` } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
			{ type: "message_stop" },
		];
		const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const model: EngineModel = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-fixture",
		name: "claude-fixture",
		baseUrl: "https://api.anthropic.com",
		compat: { supportsStrictTools: true },
		reasoning: false,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const advance = (ms: number) => {
		monotonic += ms;
		wall += ms;
	};

	for (const apiKey of ["fixture", "sk-ant-oat-fixture"]) {
		const sessionId = `thread-idle-${apiKey}`;
		t.after(() => cleanupEngineSessionResources(sessionId));
		const context: Context = {
			systemPrompt: "Fixture system prompt.",
			messages: [],
			tools: [
				{
					name: "probe",
					description: "Probe the fixture.",
					parameters: Type.Object({ path: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "prefer" },
				},
			],
		};
		const options = {
			apiKey,
			sessionId,
			cacheRetention: "long" as const,
			maxTokens: 100,
			maxRetries: 0,
			fetch,
		};
		const send = async (disableContinuation = false) => {
			const reply = await streamSimple(model, context, { ...options, disableContinuation }).result();
			strictEqual(reply.stopReason, "stop", reply.errorMessage);
			return reply;
		};
		const ask = async (text: string) => {
			context.messages.push({ role: "user", content: text, timestamp: 0 });
			const reply = await send();
			context.messages.push(reply);
			return bodies.at(-1);
		};

		strictEqual((await ask("first"))?.thread?.type, "create");
		let previousId = `msg_${bodies.length}`;
		for (const text of ["second", "third"]) {
			advance(240_000);
			const continued = await ask(text);
			deepStrictEqual(continued?.thread, { type: "continue", previous_message_id: previousId });
			strictEqual(continued?.messages.length, 1);
			previousId = `msg_${bodies.length}`;
		}

		advance(260_000);
		await send(true);
		strictEqual(bodies.at(-1)?.thread, undefined, "a keepalive neither consumes nor refreshes the thread");
		advance(40_000);
		const before = bodies.length;
		context.messages.push({ role: "user", content: "after idle", timestamp: 0 });
		const fresh = await send();
		const created = bodies.at(-1);
		strictEqual(bodies.length, before + 1, "the idle request is sent exactly once");
		deepStrictEqual(created?.thread, { type: "create" });
		strictEqual(created?.messages.length, 7);
		ok(created?.system);
		ok(Array.isArray(created?.tools) && created.tools.length === 1);
		strictEqual("betas" in (created ?? {}), false, "SDK-only fields must not leak into the wire body");
		strictEqual(headers.at(-1)?.get("anthropic-beta"), headers.at(-2)?.get("anthropic-beta"));
		ok(!fresh.diagnostics?.some((entry) => entry.type === "anthropic_thread_fallback"));

		// Compare with Pi's own new-thread serialization for exactly the same conversation and session.
		cleanupEngineSessionResources(sessionId);
		const reference = await send();
		deepStrictEqual(created, bodies.at(-1));
		context.messages.push(reference);
		previousId = `msg_${bodies.length}`;
		deepStrictEqual((await ask("continue new thread"))?.thread, {
			type: "continue",
			previous_message_id: previousId,
		});

		monotonic += 300_000;
		wall -= 600_000;
		strictEqual((await ask("wall clock moved backward"))?.thread?.type, "create");
		wall += 300_000;
		strictEqual((await ask("suspend with monotonic clock stopped"))?.thread?.type, "create");

		// Pi's fallback remains available for an unexpectedly early server expiry.
		rejectNext = "expired";
		const fallbackBefore = bodies.length;
		await ask("early expiry");
		strictEqual(bodies.length, fallbackBefore + 2);
		strictEqual(bodies.at(-2)?.thread?.type, "continue");
		strictEqual(bodies.at(-1)?.thread?.type, "create");

		advance(300_000);
		rejectNext = "failed";
		context.messages.push({ role: "user", content: "failed idle create", timestamp: 0 });
		const failed = await streamSimple(model, context, options).result();
		strictEqual(failed.stopReason, "error");
		strictEqual(bodies.at(-1)?.thread?.type, "create");
		context.messages.push(await send());
		strictEqual(bodies.at(-1)?.thread?.type, "create", "a failed replacement cannot revive the old thread");

		advance(300_000);
		rejectNext = "failed";
		const retryBefore = bodies.length;
		context.messages.push({ role: "user", content: "retry idle create", timestamp: 0 });
		const retried = await streamSimple(model, context, { ...options, maxRetries: 1 }).result();
		strictEqual(retried.stopReason, "stop", retried.errorMessage);
		strictEqual(bodies.length, retryBefore + 2);
		deepStrictEqual(bodies.at(-2), bodies.at(-1), "provider retries resend the full new-thread body");
		context.messages.push(retried);

		advance(300_000);
		rejectNext = "strict";
		await ask("strict tool downgrade");
		strictEqual(bodies.at(-2)?.tools?.[0]?.strict, true);
		ok(bodies.at(-1)?.tools?.[0]?.strict !== true);
		advance(300_000);
		await ask("strict downgrade survives idle restart");
		ok(bodies.at(-1)?.tools?.[0]?.strict !== true);

		rejectNext = "unsupported";
		await ask("endpoint refuses threads");
		strictEqual(bodies.at(-1)?.thread, undefined);
		advance(300_000);
		const offBefore = bodies.length;
		await ask("threads stay off");
		strictEqual(bodies.length, offBefore + 1);
		strictEqual(bodies.at(-1)?.thread, undefined);
	}
});
