import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";
import openai from "../../src/domains/providers/runtimes/cloud/openai.js";
import llamacpp from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetCacheSettings } from "../../src/domains/providers/types/target-descriptor.js";
import { streamSimple } from "../../src/engine/ai.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";

registerClioApiProviders();

async function request(
	runtime: RuntimeDescriptor,
	id: string,
	retention?: TargetCacheSettings["retention"],
	callRetention?: TargetCacheSettings["retention"],
) {
	const model = runtime.synthesizeModel(
		{
			id: "fixture",
			runtime: runtime.id,
			url: "https://provider.invalid",
			...(retention === undefined ? {} : { cache: { retention } }),
		},
		id,
		null,
	);
	let captured: Record<string, unknown> | undefined;
	const stream = streamSimple(
		model,
		{
			systemPrompt: "Authorized instructions.",
			messages: [{ role: "user", content: "Task suffix", timestamp: 0 }],
		},
		{
			apiKey: "fixture",
			sessionId: "actual-session",
			maxTokens: 1,
			...(callRetention === undefined ? {} : { cacheRetention: callRetention }),
			onPayload(payload) {
				captured = JSON.parse(JSON.stringify(payload));
				throw new Error("Captured provider request before network I/O");
			},
		},
	);
	for await (const _event of stream) {
		/* Stop before I/O. */
	}
	ok(captured, "real Pi serializer must reach the payload hook");
	return captured;
}

test("validated target retention reaches old and explicit-mode OpenAI serializers", async () => {
	const valid = validateSettings({
		version: 2,
		targets: [{ id: "openai", runtime: "openai", cache: { retention: "long" } }],
	});
	deepStrictEqual(valid.issues, []);
	strictEqual(valid.settings.targets[0]?.cache?.retention, "long");
	for (const cache of [{ retention: "24h" }, { retention: true }, { warmEverything: true }]) {
		ok(validateSettings({ version: 2, targets: [{ id: "openai", runtime: "openai", cache }] }).issues.length > 0);
	}
	const old = await request(openai, "gpt-5.4", "long");
	strictEqual(old.prompt_cache_retention, "24h");
	strictEqual(old.prompt_cache_key, "actual-session");
	strictEqual(old.prompt_cache_options, undefined);
	const explicit = await request(openai, "gpt-5.6-sol", "long");
	deepStrictEqual(explicit.prompt_cache_options, { ttl: "30m" });
	strictEqual(explicit.prompt_cache_retention, undefined);
	const disabled = await request(openai, "gpt-5.6-sol", "long", "none");
	deepStrictEqual(disabled.prompt_cache_options, { mode: "explicit" });
	strictEqual(disabled.prompt_cache_key, undefined);
	strictEqual(JSON.stringify(disabled).includes("prompt_cache_breakpoint"), false);
});

test("Anthropic call and target retention override the existing environment fallback", async () => {
	const previous = process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
	process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION = "long";
	try {
		const fallback = JSON.stringify(await request(anthropic, "claude-sonnet-4-5"));
		ok(fallback.includes('"ttl":"1h"'));
		const short = JSON.stringify(await request(anthropic, "claude-sonnet-4-5", "short"));
		ok(short.includes('"type":"ephemeral"'));
		strictEqual(short.includes('"ttl":"1h"'), false);
		const disabled = JSON.stringify(await request(anthropic, "claude-sonnet-4-5", "long", "none"));
		strictEqual(disabled.includes("cache_control"), false);
	} finally {
		if (previous === undefined) delete process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
		else process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION = previous;
	}
});

test("generic gateways do not inherit hosted retention and direct llama honors cache-off", async () => {
	const gateway = await request(litellm, "private-route", "long");
	strictEqual(gateway.prompt_cache_retention, undefined);
	strictEqual(gateway.cache_prompt, undefined);
	strictEqual((await request(llamacpp, "fixture", "short")).cache_prompt, true);
	strictEqual((await request(llamacpp, "fixture", "none")).cache_prompt, false);
});
