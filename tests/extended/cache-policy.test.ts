import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";
import anthropicMax from "../../src/domains/providers/runtimes/cloud/anthropic-max.js";
import openai from "../../src/domains/providers/runtimes/cloud/openai.js";
import openaiCodex from "../../src/domains/providers/runtimes/cloud/openai-codex.js";
import llamacpp from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetCacheSettings } from "../../src/domains/providers/types/target-descriptor.js";
import {
	compactEngineCodex,
	createEngineAgent,
	setEngineProviderCompactionPolicy,
	setEngineSystemPrompt,
} from "../../src/engine/agent.js";
import { completeEngineText, streamSimple } from "../../src/engine/ai.js";
import { engineMainStreamSimple } from "../../src/engine/api-registry.js";
import { sideCallCacheFamilyId, workerCacheFamilyId } from "../../src/engine/apis/cache-family.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";

registerClioApiProviders();

async function request(
	runtime: RuntimeDescriptor,
	id: string,
	retention?: TargetCacheSettings["retention"],
	callRetention?: TargetCacheSettings["retention"],
	send: typeof streamSimple = streamSimple,
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
	const stream = send(
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

test("only the main thread defaults Anthropic to the 1h TTL (#422)", async () => {
	const previous = process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
	delete process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
	const ttl1h = async (...args: Parameters<typeof request>) =>
		JSON.stringify(await request(...args)).includes('"ttl":"1h"');
	try {
		strictEqual(await ttl1h(anthropicMax, "claude-haiku-5-5", undefined, undefined, engineMainStreamSimple), true);
		strictEqual(await ttl1h(anthropicMax, "claude-haiku-5-5"), false);
		strictEqual(await ttl1h(anthropic, "claude-haiku-5-5", undefined, undefined, engineMainStreamSimple), true);
		strictEqual(await ttl1h(anthropic, "claude-haiku-5-5"), false);
		strictEqual(await ttl1h(anthropicMax, "claude-haiku-5-5", "short", undefined, engineMainStreamSimple), false);
		process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION = "short";
		strictEqual(await ttl1h(anthropicMax, "claude-haiku-5-5", undefined, undefined, engineMainStreamSimple), false);
	} finally {
		if (previous === undefined) delete process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
		else process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION = previous;
	}
});

test("workers with one stable head share a session id only where the backend routes its cache by it (FL-17)", () => {
	const read = { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } };
	const head = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		modelId: "gpt-6-luna",
		thinkingLevel: "low",
		systemPrompt: "# Identity",
		tools: [read],
		lane: 0,
	};
	const family = workerCacheFamilyId(head);
	ok(family !== undefined && /^clio-coder-w-[a-f0-9]{40}-0$/u.test(family));
	strictEqual(workerCacheFamilyId({ ...head, tools: [{ ...read }] }), family);
	for (const other of [
		{ ...head, systemPrompt: "# Identity\n" },
		{ ...head, modelId: "gpt-6.1-sol" },
		{ ...head, thinkingLevel: "high" },
		{ ...head, lane: 1 },
		{ ...head, tools: [{ ...read, description: "Read one file." }] },
		{ ...head, tools: [read, { ...read, name: "grep" }] },
	])
		ok(workerCacheFamilyId(other) !== family);
	// Only a measured session-routed backend takes the shared id; elsewhere a worker keeps an id of its own.
	for (const api of ["anthropic-messages", "openai-completions", "openai-responses"])
		strictEqual(workerCacheFamilyId({ ...head, api }), undefined);
});

test("tool-free side calls of one head share a session id on Codex and only there (OI-6)", async () => {
	const model = openaiCodex.synthesizeModel(
		{ id: "fixture", runtime: "openai-codex", url: "http://127.0.0.1:9" },
		"gpt-6-luna",
		null,
	);
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${claims.toString("base64url")}.signature`;
	const dir = mkdtempSync(join(tmpdir(), "clio-side-family-"));
	const previous = process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
	let calls = 0;
	const key = async (systemPrompt: string, userPrompt: string) => {
		const path = join(dir, `${calls++}.jsonl`);
		process.env.CLIO_CODER_PROVIDER_DUMP_PATH = path;
		await completeEngineText({
			model,
			systemPrompt,
			userPrompt,
			maxTokens: 16,
			thinkingLevel: "low",
			signal: new AbortController().signal,
			timeoutMs: 5_000,
			apiKey,
			transport: "sse",
		}).catch(() => undefined);
		const dump = JSON.parse(readFileSync(path, "utf8").trim()) as { payloads: Array<{ prompt_cache_key?: unknown }> };
		return dump.payloads.at(-1)?.prompt_cache_key;
	};
	try {
		const family = sideCallCacheFamilyId({
			api: model.api,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: "low",
			systemPrompt: "# Memory review",
		});
		ok(family !== undefined && /^clio-coder-s-[a-f0-9]{40}$/u.test(family));
		strictEqual(await key("# Memory review", "first task"), family);
		strictEqual(await key("# Memory review", "another task"), family);
		ok((await key("# Judge", "first task")) !== family);
		for (const api of ["anthropic-messages", "openai-completions", "openai-responses"])
			strictEqual(
				sideCallCacheFamilyId({ api, provider: "p", modelId: "m", thinkingLevel: "low", systemPrompt: "x" }),
				undefined,
			);
	} finally {
		if (previous === undefined) delete process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
		else process.env.CLIO_CODER_PROVIDER_DUMP_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the main thread's Codex request sends the pinned prompt layer as its own item, the rest right after it", async () => {
	const model = openaiCodex.synthesizeModel(
		{ id: "fixture", runtime: "openai-codex", url: "http://127.0.0.1:9" },
		"gpt-6-luna",
		null,
	);
	const pinned = "Install-wide identity and harness.\n";
	const tail = "Project handbook and runtime.\n";
	const hash = createHash("sha256").update(pinned).digest("hex");
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${claims.toString("base64url")}.signature`;
	const dir = mkdtempSync(join(tmpdir(), "clio-codex-split-"));
	const previous = process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
	type Body = { instructions?: string; input: Array<Record<string, unknown>>; prompt_cache_key?: unknown };
	let calls = 0;
	// The diagnostic dump records the body after every wrapper; aborting from the innermost hook sends nothing.
	const send = async (scope: "main" | "side", prefixHash = hash, transport?: "sse") => {
		const path = join(dir, `${calls++}.jsonl`);
		process.env.CLIO_CODER_PROVIDER_DUMP_PATH = path;
		const abort = new AbortController();
		const options = {
			apiKey,
			sessionId: "session",
			signal: abort.signal,
			clioCoderPinnedPrefix: { chars: pinned.length, hash: prefixHash },
			...(transport ? { transport } : {}),
			onPayload: () => {
				abort.abort();
				return undefined;
			},
		};
		const context = { systemPrompt: pinned + tail, messages: [{ role: "user" as const, content: "Task", timestamp: 0 }] };
		const stream = (scope === "main" ? engineMainStreamSimple : streamSimple)(model, context, options as never);
		for await (const _event of stream) {
			/* Drain to the aborted end. */
		}
		const dump = JSON.parse(readFileSync(path, "utf8").trim()) as { payloads: Body[] };
		return dump.payloads.at(-1) as Body;
	};
	const text = (item: Record<string, unknown> | undefined) =>
		(item?.content as Array<{ text: string }> | undefined)?.map((part) => part.text).join("");
	try {
		const main = await send("main");
		const side = await send("side");
		const at = main.input.findIndex((item) => item.role === "developer" && text(item) === pinned);
		ok(at >= 0, JSON.stringify(main.input.map((item) => item.type ?? item.role)));
		deepStrictEqual(main.input[at + 1], { ...main.input[at], content: [{ type: "input_text", text: tail }] });
		strictEqual(`${text(main.input[at])}${text(main.input[at + 1])}`, pinned + tail, "concatenates to the prompt");
		// Workers and side calls, and a prompt whose leading bytes are not the pinned layer, keep today's request.
		strictEqual(text(side.input[at]), pinned + tail);
		deepStrictEqual(main.input.slice(0, at), side.input.slice(0, at));
		deepStrictEqual(main.input.slice(at + 2), side.input.slice(at + 1));
		strictEqual(main.prompt_cache_key, side.prompt_cache_key);
		deepStrictEqual(await send("main", "0".repeat(64)), side);
		// Without a continuation the prompt stays in instructions: the pinned part there, the rest the first input item.
		const stock = await send("main", hash, "sse");
		strictEqual(stock.instructions, pinned);
		deepStrictEqual(stock.input[0], {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: tail }],
		});
		strictEqual((await send("side", hash, "sse")).instructions, pinned + tail);
	} finally {
		if (previous === undefined) delete process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
		else process.env.CLIO_CODER_PROVIDER_DUMP_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the main thread's public Responses request marks the pinned prompt layer with its own breakpoint (PV-3)", async () => {
	const pinned = "Install-wide identity and harness.\n";
	const tail = "Project handbook and runtime.\n";
	const hash = createHash("sha256").update(pinned).digest("hex");
	const dir = mkdtempSync(join(tmpdir(), "clio-responses-split-"));
	const previous = process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
	type Body = { input: Array<{ role?: string; content?: unknown }>; prompt_cache_options?: unknown };
	let calls = 0;
	const send = async (
		modelId: string,
		scope: "main" | "side",
		cacheRetention?: "none" | "short",
		prefixHash = hash,
	): Promise<Body> => {
		const model = openai.synthesizeModel(
			{ id: "fixture", runtime: "openai", url: "https://api.openai.com/v1" },
			modelId,
			null,
		);
		const path = join(dir, `${calls++}.jsonl`);
		process.env.CLIO_CODER_PROVIDER_DUMP_PATH = path;
		const abort = new AbortController();
		const options = {
			apiKey: "sk-fixture",
			sessionId: "session",
			signal: abort.signal,
			clioCoderPinnedPrefix: { chars: pinned.length, hash: prefixHash },
			...(cacheRetention ? { cacheRetention } : {}),
			onPayload: () => {
				abort.abort();
				return undefined;
			},
		};
		const context = { systemPrompt: pinned + tail, messages: [{ role: "user" as const, content: "Task", timestamp: 0 }] };
		const stream = (scope === "main" ? engineMainStreamSimple : streamSimple)(model, context, options as never);
		for await (const _event of stream) {
			/* Drain to the aborted end. */
		}
		return (JSON.parse(readFileSync(path, "utf8").trim()) as { payloads: Body[] }).payloads.at(-1) as Body;
	};
	try {
		const main = await send("gpt-6-luna", "main");
		deepStrictEqual(main.input[0]?.content, [
			{ type: "input_text", text: pinned, prompt_cache_breakpoint: { mode: "explicit" } },
			{ type: "input_text", text: tail },
		]);
		const side = await send("gpt-6-luna", "side");
		strictEqual(side.input[0]?.content, pinned + tail, "workers and side calls keep Pi's request");
		deepStrictEqual({ ...main.input[0], content: side.input[0]?.content }, side.input[0]);
		deepStrictEqual(main.input.slice(1), side.input.slice(1));
		// Before GPT-5.6, with caching off, or when the leading bytes are not the pinned layer: the request Pi built.
		strictEqual((await send("gpt-5.5", "main")).input[0]?.content, pinned + tail);
		const off = await send("gpt-6-luna", "main", "none");
		deepStrictEqual(off.prompt_cache_options, { mode: "explicit" });
		strictEqual(off.input[0]?.content, pinned + tail);
		strictEqual((await send("gpt-6-luna", "main", undefined, "0".repeat(64))).input[0]?.content, pinned + tail);
	} finally {
		if (previous === undefined) delete process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
		else process.env.CLIO_CODER_PROVIDER_DUMP_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("native compaction on Codex sends the pinned prompt layer as its own item, as the turns do", async () => {
	const model = openaiCodex.synthesizeModel(
		{ id: "fixture", runtime: "openai-codex", url: "http://127.0.0.1:9" },
		"gpt-6-luna",
		null,
	);
	const pinned = "Install-wide identity and harness.\n";
	const tail = "Project handbook and runtime.\n";
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${claims.toString("base64url")}.signature`;
	const dir = mkdtempSync(join(tmpdir(), "clio-codex-compact-split-"));
	const path = join(dir, "dump.jsonl");
	const previous = process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
	process.env.CLIO_CODER_PROVIDER_DUMP_PATH = path;
	const abort = new AbortController();
	try {
		const { agent } = createEngineAgent({
			initialState: { model, systemPrompt: "" },
			sessionId: "session",
			getApiKey: () => apiKey,
			onPayload: () => {
				abort.abort();
				return undefined;
			},
		});
		setEngineSystemPrompt(agent, pinned + tail, {
			chars: pinned.length,
			hash: createHash("sha256").update(pinned).digest("hex"),
		});
		agent.state.messages = [...agent.state.messages, { role: "user", content: "Task", timestamp: 0 }];
		setEngineProviderCompactionPolicy(agent, () => true);
		await compactEngineCodex(agent, { signal: abort.signal }).catch(() => undefined);
		const dump = JSON.parse(readFileSync(path, "utf8").trim()) as {
			payloads: Array<{ input: Array<{ role?: string; type?: string; content?: Array<{ text: string }> }> }>;
		};
		const body = dump.payloads.at(-1);
		const developer = (body?.input ?? [])
			.filter((item) => item.role === "developer")
			.map((item) => item.content?.[0]?.text);
		ok(developer?.includes(pinned), JSON.stringify(developer));
		strictEqual(developer[developer.indexOf(pinned) + 1], tail);
		ok(body?.input.some((item) => item.type === "compaction_trigger"));
	} finally {
		if (previous === undefined) delete process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
		else process.env.CLIO_CODER_PROVIDER_DUMP_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("generic gateways do not inherit hosted retention and direct llama honors cache-off", async () => {
	const gateway = await request(litellm, "private-route", "long");
	strictEqual(gateway.prompt_cache_retention, undefined);
	strictEqual(gateway.cache_prompt, undefined);
	strictEqual((await request(llamacpp, "fixture", "short")).cache_prompt, true);
	strictEqual((await request(llamacpp, "fixture", "none")).cache_prompt, false);
});

test("deployment bindings and warm bounds are strict settings with no implicit administration", () => {
	const cache = {
		deployment: { backend: "llamacpp", controlUrl: "http://127.0.0.1:8080", model: "model", build: "b1-c841aee" },
		warm: { startup: true, maxInputTokens: 4096, maxDurationMs: 10000, cooldownMs: 60000 },
	};
	const parse = (value: unknown) =>
		validateSettings({ version: 2, targets: [{ id: "local", runtime: "llamacpp", cache: value }] });
	ok(parse({ ...cache, warm: { startup: "yes" } }).issues.length > 0);
	const valid = parse(cache);
	deepStrictEqual(valid.issues, []);
	deepStrictEqual(valid.settings.targets[0]?.cache, cache);
	strictEqual(valid.settings.targets[0]?.lifecycle, undefined);
	for (const controlUrl of ["file:///tmp/socket", "http://user:password@localhost", "http://localhost?token=secret"])
		ok(parse({ ...cache, deployment: { ...cache.deployment, controlUrl } }).issues.length > 0);
	for (const maxDurationMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
		ok(parse({ ...cache, warm: { maxDurationMs } }).issues.length > 0);
});
