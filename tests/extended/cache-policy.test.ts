import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { validateSettings } from "../../src/core/config.js";
import { FILE_LOCK_ACQUIRE_TIMEOUT_MS, StateFileLockTimeoutError } from "../../src/core/state-file-lock.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import type { RuntimeNoticePayload } from "../../src/core/telemetry/live-events.js";
import {
	capacityStateLockPath,
	MAIN_CACHE_LANE_LOCK_TIMEOUT_MS,
	mainCacheLaneStore,
} from "../../src/domains/dispatch/capacity-lease.js";
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
import { cleanupEngineSessionResources, completeEngineText, streamSimple } from "../../src/engine/ai.js";
import { engineMainStreamSimple, engineStreamSimple } from "../../src/engine/api-registry.js";
import {
	sideCallCacheFamilyId,
	useMainCacheLaneStore,
	withMainCacheRouting,
	workerCacheFamilyId,
} from "../../src/engine/apis/cache-family.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { setResidencyNoticeSink } from "../../src/engine/apis/residency.js";
import {
	closeResponsesWebSockets,
	newTransportCall,
	responsesWebSocketFetch,
} from "../../src/engine/apis/responses-websocket.js";
import { engineModels } from "../../src/engine/models.js";
import type { CodexTransportObservation, EngineModel } from "../../src/engine/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

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
		// Only the main thread routes to the cache of its pinned head (M-11); a side call keeps the session it was given.
		ok(typeof main.prompt_cache_key === "string" && main.prompt_cache_key.startsWith("clio-coder-m-"));
		strictEqual(side.prompt_cache_key, "session");
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

test("main sessions with one pinned head share a Codex cache routing key and keep their own turn state (M-11)", async () => {
	const model = openaiCodex.synthesizeModel(
		{ id: "fixture", runtime: "openai-codex", url: "https://codex.invalid/backend-api" },
		"gpt-6-luna",
		null,
	);
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${claims.toString("base64url")}.signature`;
	const pinned = "Install-wide identity and harness.\n";
	const read = { name: "read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }) };
	const sent: Array<{ key: unknown; header: string | null; turnState: string | null }> = [];
	let issued = 0;
	const fetch = async (_url: unknown, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const raw = init?.body;
		const text =
			headers.get("content-encoding") === "zstd" && raw instanceof Uint8Array
				? zstdDecompressSync(raw).toString("utf8")
				: String(raw);
		sent.push({
			key: (JSON.parse(text) as { prompt_cache_key?: unknown }).prompt_cache_key,
			header: headers.get("session-id"),
			turnState: headers.get("x-codex-turn-state"),
		});
		const response = {
			id: `resp_${sent.length}`,
			status: "completed",
			output: [],
			usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
		};
		const events = [
			{ type: "response.created", response: { ...response, status: "in_progress" } },
			{ type: "response.completed", response },
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream", "x-codex-turn-state": `state-${++issued}` },
		});
	};
	// Two fresh sessions in two repositories: the same install layer and tools, a session layer of their own.
	const send = async (sessionId: string, sessionLayer: string, messages: unknown[], layer = pinned) => {
		const hash = createHash("sha256").update(layer).digest("hex");
		await engineMainStreamSimple(
			model,
			{ systemPrompt: layer + sessionLayer, tools: [read], messages } as never,
			{
				apiKey,
				sessionId,
				transport: "sse",
				fetch,
				clioCoderPinnedPrefix: { chars: layer.length, hash },
			} as never,
		).result();
		return sent.at(-1);
	};
	const task = { role: "user", content: "Say one word.", timestamp: 1 };
	const call = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "toolUse",
		timestamp: 2,
	};
	const result = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [],
		isError: false,
		timestamp: 3,
	};
	const first = await send("session-repo-a", "Repo A handbook.\n", [task]);
	ok(typeof first?.key === "string" && /^clio-coder-m-[a-f0-9]{40}-0$/u.test(first.key), String(first?.key));
	// Two live sessions of one head take lanes of their own, as live workers do (FL-17).
	const concurrent = await send("session-repo-b", "Repo B handbook.\n", [task]);
	strictEqual(concurrent?.key, String(first.key).replace(/-0$/u, "-1"), "a concurrent live session takes the next lane");
	// The backend routes by the header: it carries the same key as the body.
	strictEqual(first?.header, first?.key);
	strictEqual(concurrent?.header, concurrent?.key);
	// Continuation stays per session: the second session never carries the first one's turn token, its tool round does.
	strictEqual(concurrent?.turnState, null);
	strictEqual((await send("session-repo-a", "Repo A handbook.\n", [task, call, result]))?.turnState, "state-1");
	// A session that ends releases its lane, and the next session of that head reads the cache it routed to.
	cleanupEngineSessionResources("session-repo-a");
	const next = await send("session-repo-d", "Repo D handbook.\n", [task]);
	strictEqual(next?.key, first?.key, "a released lane is reused");
	strictEqual((await send("session-repo-b", "Repo B handbook.\n", [task, call, result]))?.key, concurrent?.key);
	// Routing an already routed request changes nothing: no second lane, no routing id taken as a conversation.
	const bContext = { systemPrompt: `${pinned}Repo B handbook.\n`, tools: [read], messages: [task] } as never;
	const pinnedPrefix = { chars: pinned.length, hash: createHash("sha256").update(pinned).digest("hex") };
	const routed = withMainCacheRouting(model, bContext, {
		sessionId: "session-repo-b",
		clioCoderPinnedPrefix: pinnedPrefix,
	} as never);
	strictEqual((routed as { sessionId?: string } | undefined)?.sessionId, concurrent?.key);
	strictEqual(withMainCacheRouting(model, bContext, routed), routed, "routing twice is routing once");
	const other = await send("session-repo-c", "Repo A handbook.\n", [task], "Another install's identity.\n");
	ok(
		typeof other?.key === "string" && other.key.endsWith("-0") && other.key !== first?.key,
		"another head routes elsewhere",
	);
	for (const session of ["session-repo-b", "session-repo-c", "session-repo-d"]) cleanupEngineSessionResources(session);
	// With the cross-process store registered, the lane is the store's and a session's cleanup releases it there.
	const stored: string[] = [];
	useMainCacheLaneStore({
		claim: (key, conversation) => {
			stored.push(`claim ${conversation} ${key.includes(model.baseUrl)}`);
			return 7;
		},
		release: (conversation) => stored.push(`release ${conversation}`),
	});
	try {
		const storeLane = await send("session-store", "Repo A handbook.\n", [task]);
		strictEqual(storeLane?.key, String(first.key).replace(/-0$/u, "-7"));
		cleanupEngineSessionResources("session-store");
		deepStrictEqual(stored, ["claim session-store true", "release session-store"]);
	} finally {
		useMainCacheLaneStore(undefined);
	}
});

test("a main lane claim behind a held admission lock waits a bounded time, then routes on an in-process lane with one host notice per conversation (M-11)", async (t) => {
	const env = await isolateClioEnv("clio-coder-main-lane-lock-");
	t.after(() => env.restore());
	// Another live Clio process holds the admission lock and does not let go: this host, a live pid that is not ours.
	const lockPath = `${capacityStateLockPath()}.lock`;
	mkdirSync(dirname(lockPath), { recursive: true });
	writeFileSync(lockPath, `${JSON.stringify({ host: hostname(), pid: process.ppid, at: new Date().toISOString() })}\n`);
	const notices: RuntimeNoticePayload[] = [];
	setResidencyNoticeSink((notice) => notices.push(notice));
	const journaled: unknown[] = [];
	const unsubscribe = telemetryHub().subscribe("cache.lane_fell_back", (payload) => {
		journaled.push(payload);
	});
	const failures: unknown[] = [];
	useMainCacheLaneStore({
		claim: (key, conversation) => {
			try {
				return mainCacheLaneStore.claim(key, conversation);
			} catch (error) {
				failures.push(error);
				throw error;
			}
		},
		release: (conversation) => mainCacheLaneStore.release(conversation),
	});
	t.after(() => {
		useMainCacheLaneStore(undefined);
		setResidencyNoticeSink(null);
		unsubscribe();
		cleanupEngineSessionResources("held-lock-session");
	});
	const model = openaiCodex.synthesizeModel(
		{ id: "fixture", runtime: "openai-codex", url: "https://codex.invalid/backend-api" },
		"gpt-6-luna",
		null,
	);
	const route = (layer: string) =>
		(
			withMainCacheRouting(
				model,
				{ systemPrompt: `${layer}Repo handbook.\n`, tools: [], messages: [] } as never,
				{
					sessionId: "held-lock-session",
					clioCoderPinnedPrefix: { chars: layer.length, hash: createHash("sha256").update(layer).digest("hex") },
				} as never,
			) as { sessionId?: string } | undefined
		)?.sessionId;
	// The claim gives up after the short bound, not the 20 s default every other admission caller waits.
	ok(MAIN_CACHE_LANE_LOCK_TIMEOUT_MS <= 2_000 && MAIN_CACHE_LANE_LOCK_TIMEOUT_MS < FILE_LOCK_ACQUIRE_TIMEOUT_MS);
	const first = route("Install identity.\n");
	ok(typeof first === "string" && /^clio-coder-m-[a-f0-9]{40}-0$/u.test(first), String(first));
	strictEqual(failures.length, 1);
	ok(failures[0] instanceof StateFileLockTimeoutError);
	match(String((failures[0] as Error).message), new RegExp(`timed out after ${MAIN_CACHE_LANE_LOCK_TIMEOUT_MS}ms`, "u"));
	strictEqual(notices.length, 1);
	strictEqual(notices[0]?.kind, "cache-lane-fallback");
	match(notices[0]?.message ?? "", /in-process cache lane/u);
	deepStrictEqual(journaled, [{ reason: "lock-timeout", timeoutMs: MAIN_CACHE_LANE_LOCK_TIMEOUT_MS, lane: 0 }]);
	// Later turns keep the in-process lane without waiting on the store again.
	strictEqual(route("Install identity.\n"), first);
	strictEqual(failures.length, 1);
	// A new head for the same conversation tries the store again and journals that fallback, but says so only once.
	ok(route("Another identity.\n")?.endsWith("-0"));
	strictEqual(failures.length, 2);
	strictEqual(journaled.length, 2);
	strictEqual(notices.length, 1, "one host notice per conversation");
	// The peer's lock was waited on, never taken over.
	ok(existsSync(lockPath));
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
		cacheRetention?: "none" | "short" | "long",
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
		// Long retention keeps the install-wide span 12 hours; the conversation keeps the request's 30 minutes (OI-7).
		const long = await send("gpt-6-luna", "main", "long");
		deepStrictEqual(long.prompt_cache_options, { ttl: "30m" });
		deepStrictEqual((long.input[0]?.content as Array<Record<string, unknown>>)[0]?.prompt_cache_breakpoint, {
			mode: "explicit",
			ttl: "12h",
		});
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

test("a public Responses request asks for cache diagnostics against the previous response and keeps the verdict (PV-2)", async () => {
	const model = openai.synthesizeModel(
		{ id: "fixture", runtime: "openai", url: "https://api.openai.com/v1" },
		"gpt-6-luna",
		null,
	);
	const bodies: Array<Record<string, unknown>> = [];
	const diagnostics = { type: "cache_miss", reason: "tools_changed", cache_missed_tokens: 4096 };
	const sse = (events: unknown[]) =>
		new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	const fetch = async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const response = {
			id: "resp_2",
			object: "response",
			status: "completed",
			model: "gpt-6-luna",
			output: [],
			usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
			prompt_cache_diagnostics: diagnostics,
		};
		return sse([
			{ type: "response.created", response: { ...response, status: "in_progress" } },
			{ type: "response.completed", response },
		]);
	};
	const previous = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: "resp_1",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop" as const,
		timestamp: 0,
	};
	const send = async (messages: unknown[]) => {
		const stream = streamSimple(
			model,
			{ systemPrompt: "# Identity", messages } as never,
			{
				apiKey: "sk-fixture",
				sessionId: "session",
				cacheRetention: "long",
				fetch,
			} as never,
		);
		return (await stream.result()) as { responsesCacheDiagnostic?: unknown };
	};
	const user = (content: string) => ({ role: "user", content, timestamp: 0 });
	const first = await send([user("Task")]);
	strictEqual(first.responsesCacheDiagnostic, undefined, "a first request has nothing to compare against");
	deepStrictEqual(bodies[0]?.prompt_cache_options, { ttl: "30m" });
	const second = await send([user("Task"), previous, user("Next")]);
	// The comparison joins the options Pi built instead of replacing them.
	deepStrictEqual(bodies[1]?.prompt_cache_options, { ttl: "30m", comparison_response_id: "resp_1" });
	deepStrictEqual(second.responsesCacheDiagnostic, {
		provider: "openai",
		type: "cache_miss",
		reason: "tools_changed",
		missedInputTokens: 4096,
	});
	// A response from another route in the transcript is not a comparison this backend can resolve.
	await send([user("Task"), { ...previous, provider: "openai-codex" }, user("Next")]);
	deepStrictEqual(bodies[2]?.prompt_cache_options, { ttl: "30m" });
});

test("a Codex turn sends back the backend's x-codex-turn-state on its later requests and never into the next turn (PV-2)", async () => {
	const model = openaiCodex.synthesizeModel(
		{ id: "fixture", runtime: "openai-codex", url: "https://codex.invalid/backend-api" },
		"gpt-6-luna",
		null,
	);
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${claims.toString("base64url")}.signature`;
	const sent: Array<string | null> = [];
	let issued = 0;
	const fetch = async (_url: unknown, init?: RequestInit) => {
		sent.push(new Headers(init?.headers).get("x-codex-turn-state"));
		const response = {
			id: `resp_${sent.length}`,
			status: "completed",
			output: [],
			usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
		};
		const events = [
			{ type: "response.created", response: { ...response, status: "in_progress" } },
			{ type: "response.completed", response },
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream", "x-codex-turn-state": `state-${++issued}` },
		});
	};
	const send = async (messages: unknown[], sessionId = "turn-state-session") => {
		const stream = streamSimple(
			model,
			{ systemPrompt: "# Identity", messages } as never,
			{
				apiKey,
				sessionId,
				transport: "sse",
				fetch,
			} as never,
		);
		await stream.result();
	};
	const task = { role: "user", content: "Task", timestamp: 1 };
	const call = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "toolUse",
		timestamp: 2,
	};
	const result = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [],
		isError: false,
		timestamp: 3,
	};
	await send([task]);
	await send([task, call, result]);
	await send([task, call, result, call, result]);
	await send([task, call, result, { role: "user", content: "Next", timestamp: 4 }]);
	await send([task], "another-session");
	// The turn's first token holds for the turn; the next turn and another conversation start without one.
	deepStrictEqual(sent, [null, "state-1", "state-1", null, null]);
	// A warm ends on the assistant's message: it opens the next turn without the last turn's token, and the token it
	// is issued travels with that turn's requests.
	const answer = { ...call, content: [{ type: "text", text: "Done." }], stopReason: "stop" };
	const history = [task, call, result, answer];
	await send(history);
	await send([...history, { role: "user", content: "Again", timestamp: 5 }]);
	deepStrictEqual(sent.slice(5), [null, "state-6"]);
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

describe("Responses WebSocket transport (PV-2, OI-10)", () => {
	type Payload = Record<string, unknown>;

	const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${account.toString("base64url")}.sig`;
	const usage = { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } };

	function frameOf(opcode: number, payload: Buffer): Buffer {
		const length = payload.length;
		let header: Buffer;
		if (length < 126) header = Buffer.from([0x80 | opcode, length]);
		else if (length < 65_536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		return Buffer.concat([header, payload]);
	}

	interface Connection {
		send(event: Payload): void;
		close(code: number): void;
	}

	interface Fixture {
		url: string;
		frames: Payload[];
		upgrades: IncomingMessage[];
		posts: number;
		close(): Promise<void>;
	}

	/** A Responses backend on loopback: a hand-rolled RFC 6455 endpoint for the socket and plain SSE for `POST`. */
	async function backend(options: {
		onFrame: (frame: Payload, connection: Connection, index: number) => void;
		handshake?: Record<string, string>;
		rejectUpgrade?: boolean;
		sse?: Payload[];
	}): Promise<Fixture> {
		const frames: Payload[] = [];
		const upgrades: IncomingMessage[] = [];
		const sockets = new Set<Socket>();
		let posts = 0;
		const server: Server = createServer((request, response) => {
			posts += 1;
			request.resume();
			request.on("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const event of options.sse ?? []) response.write(`data: ${JSON.stringify(event)}\n\n`);
				response.end();
			});
		});
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		server.on("upgrade", (request, socket: Socket) => {
			upgrades.push(request);
			if (options.rejectUpgrade) {
				socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
				return;
			}
			const accept = createHash("sha1")
				.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest("base64");
			const extra = Object.entries(options.handshake ?? {}).map(([name, value]) => `${name}: ${value}\r\n`);
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra.join("")}\r\n`,
			);
			const connection: Connection = {
				send: (event) => socket.write(frameOf(1, Buffer.from(JSON.stringify(event)))),
				close: (code) => {
					const body = Buffer.alloc(2);
					body.writeUInt16BE(code, 0);
					socket.end(frameOf(8, body));
				},
			};
			let buffer = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk]);
				for (;;) {
					if (buffer.length < 2) return;
					const opcode = (buffer[0] ?? 0) & 0x0f;
					const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
					let length = (buffer[1] ?? 0) & 0x7f;
					let offset = 2;
					if (length === 126) {
						if (buffer.length < 4) return;
						length = buffer.readUInt16BE(2);
						offset = 4;
					} else if (length === 127) {
						if (buffer.length < 10) return;
						length = Number(buffer.readBigUInt64BE(2));
						offset = 10;
					}
					const maskAt = offset;
					if (masked) offset += 4;
					if (buffer.length < offset + length) return;
					let payload = Buffer.from(buffer.subarray(offset, offset + length));
					if (masked) {
						const mask = buffer.subarray(maskAt, maskAt + 4);
						payload = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
					}
					buffer = buffer.subarray(offset + length);
					if (opcode === 1) {
						const frame = JSON.parse(payload.toString("utf8")) as Payload;
						frames.push(frame);
						options.onFrame(frame, connection, frames.length - 1);
					} else if (opcode === 8) {
						if (!socket.writableEnded) socket.end(frameOf(8, payload.subarray(0, 2)));
					} else if (opcode === 9 && !socket.writableEnded) socket.write(frameOf(10, payload));
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		return {
			url: `http://127.0.0.1:${port}`,
			frames,
			upgrades,
			get posts() {
				return posts;
			},
			close: async () => {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
		};
	}

	function textEvents(id: string, text: string): Payload[] {
		const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed" };
		return [
			{ type: "response.created", response: { id, status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{
				type: "response.content_part.added",
				item_id: item.id,
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "" },
			},
			{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { ...item, content: [{ type: "output_text", text, annotations: [] }] },
			},
			{ type: "response.completed", response: { id, status: "completed", usage } },
		];
	}

	function toolCallEvents(id: string): Payload[] {
		const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' };
		return [
			{ type: "response.created", response: { id, status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: item.arguments },
			{ type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
			{ type: "response.completed", response: { id, status: "completed", usage } },
		];
	}

	function codexAt(url: string): EngineModel {
		const model = engineModels.getModel("openai-codex" as never, "gpt-6-luna") as EngineModel | undefined;
		ok(model, "the catalog carries openai-codex gpt-6-luna");
		return { ...model, baseUrl: url };
	}

	const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });
	const tools = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];

	async function call(model: EngineModel, context: Context, sessionId: string, extra: Payload = {}) {
		const message = await engineStreamSimple(model, context, { apiKey, sessionId, ...extra }).result();
		return { message, transport: (message as { codexTransport?: CodexTransportObservation }).codexTransport };
	}

	afterEach(() => closeResponsesWebSockets());

	test("a tool round continues on the same socket as a delta and replays the handshake's turn state", async (t) => {
		const env = await isolateClioEnv("clio-coder-responses-ws-");
		t.after(() => env.restore());
		const server = await backend({
			handshake: { "x-codex-turn-state": "ts-1" },
			onFrame: (_frame, connection, index) => {
				for (const event of index === 0 ? toolCallEvents("resp_1") : textEvents("resp_2", "done")) connection.send(event);
			},
		});
		t.after(() => server.close());
		const model = codexAt(server.url);
		const first: Context = { systemPrompt: "Fixture.", tools, messages: [user("inspect", 1)] };
		const a = await call(model, first, "ws-turn");
		strictEqual(a.message.stopReason, "toolUse", a.message.errorMessage);
		strictEqual(a.transport?.mode, "websocket");
		strictEqual(a.transport?.request, "full");
		strictEqual(a.transport?.counters?.connectionsCreated, 1);
		const toolCall = a.message.content.find((part) => part.type === "toolCall");
		ok(toolCall && toolCall.type === "toolCall");
		const second: Context = {
			...first,
			messages: [
				...first.messages,
				a.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const b = await call(model, second, "ws-turn");
		strictEqual(b.message.stopReason, "stop", b.message.errorMessage);
		strictEqual(server.upgrades.length, 1, "the second request reuses the first socket");
		strictEqual(b.transport?.request, "delta");
		strictEqual(b.transport?.counters?.connectionsReused, 1);
		const [opening, continued] = server.frames;
		strictEqual(opening?.type, "response.create");
		strictEqual(opening?.previous_response_id, undefined);
		strictEqual((opening?.client_metadata as Payload | undefined)?.["x-codex-turn-state"], undefined);
		strictEqual(continued?.previous_response_id, "resp_1");
		deepStrictEqual(
			(continued?.input as Payload[]).map((item) => item.type),
			["function_call_output"],
			"only the tool result is new to the provider",
		);
		strictEqual((continued?.client_metadata as Payload)["x-codex-turn-state"], "ts-1");
		strictEqual(server.upgrades[0]?.headers["x-codex-turn-state"], undefined, "the token never rides the handshake");
		strictEqual(server.upgrades[0]?.headers["openai-beta"], "responses_websockets=2026-02-06");
		strictEqual(server.posts, 0);
	});

	test("the turn after a generate:false warm chains to the warm response with only the new message", async (t) => {
		const env = await isolateClioEnv("clio-coder-responses-ws-");
		t.after(() => env.restore());
		const server = await backend({
			onFrame: (_frame, connection, index) => {
				const events =
					index === 0
						? [
								{ type: "response.created", response: { id: "warm_1", status: "in_progress" } },
								{ type: "response.completed", response: { id: "warm_1", status: "completed", output: [], usage } },
							]
						: textEvents("resp_2", "hello");
				for (const event of events) connection.send(event);
			},
		});
		t.after(() => server.close());
		const model = codexAt(server.url);
		const history: Context = { systemPrompt: "Fixture.", tools, messages: [user("earlier", 1)] };
		await call(model, history, "ws-warm", {
			onPayload: (payload: unknown) => ({ ...(payload as Payload), generate: false }),
		});
		const turn = await call(model, { ...history, messages: [...history.messages, user("now", 2)] }, "ws-warm");
		strictEqual(turn.message.stopReason, "stop", turn.message.errorMessage);
		strictEqual(server.frames[0]?.generate, false);
		strictEqual(server.frames[1]?.previous_response_id, "warm_1");
		strictEqual(server.frames[1]?.generate, undefined);
		strictEqual((server.frames[1]?.input as unknown[]).length, 1);
		strictEqual(turn.transport?.request, "delta");
	});

	test("a lost continuation resends the request in full once, and the call succeeds", async (t) => {
		const env = await isolateClioEnv("clio-coder-responses-ws-");
		t.after(() => env.restore());
		const server = await backend({
			onFrame: (frame, connection, index) => {
				if (index === 1) {
					ok(frame.previous_response_id, "the second request tried a delta");
					connection.send({ type: "error", error: { code: "previous_response_not_found", message: "gone" } });
					return;
				}
				for (const event of textEvents(`resp_${index + 1}`, "ok")) connection.send(event);
			},
		});
		t.after(() => server.close());
		const model = codexAt(server.url);
		const first: Context = { systemPrompt: "Fixture.", tools, messages: [user("one", 1)] };
		const a = await call(model, first, "ws-lost");
		const b = await call(model, { ...first, messages: [...first.messages, a.message, user("two", 2)] }, "ws-lost");
		strictEqual(b.message.stopReason, "stop", b.message.errorMessage);
		strictEqual(server.frames.length, 3);
		strictEqual(server.frames[2]?.previous_response_id, undefined);
		strictEqual(
			(server.frames[2]?.input as unknown[]).length,
			(server.frames[0]?.input as unknown[]).length + 2,
			"the resend carries the whole conversation",
		);
		strictEqual(b.transport?.counters?.deltaRequests, 1);
		strictEqual(b.transport?.counters?.fullContextRequests, 1);
		strictEqual(b.transport?.request, "full");
		strictEqual(server.posts, 0, "recovery stays on the socket");
	});

	test("a refused handshake sends the request over SSE and pins the session for the cooldown", async (t) => {
		const env = await isolateClioEnv("clio-coder-responses-ws-");
		t.after(() => env.restore());
		const server = await backend({ rejectUpgrade: true, onFrame: () => {}, sse: textEvents("resp_sse", "via http") });
		t.after(() => server.close());
		const model = codexAt(server.url);
		const context: Context = { systemPrompt: "Fixture.", tools, messages: [user("hi", 1)] };
		const a = await call(model, context, "ws-refused");
		strictEqual(a.message.stopReason, "stop", a.message.errorMessage);
		strictEqual(a.transport?.mode, "sse");
		strictEqual(a.transport?.fallbackActive, true);
		strictEqual(a.transport?.reason, "transport_failure");
		strictEqual(a.transport?.counters?.websocketFailures, 1);
		strictEqual(a.transport?.counters?.sseFallbacks, 1);
		const b = await call(
			model,
			{ ...context, messages: [...context.messages, a.message, user("again", 2)] },
			"ws-refused",
		);
		strictEqual(b.message.stopReason, "stop", b.message.errorMessage);
		strictEqual(server.upgrades.length, 1, "the cooled session does not retry the socket");
		strictEqual(b.transport?.fallbackActive, true);
		strictEqual(server.posts, 2);
	});

	test("a frame too big for the socket goes over SSE without pinning the session", async (t) => {
		const env = await isolateClioEnv("clio-coder-responses-ws-");
		t.after(() => env.restore());
		const server = await backend({
			onFrame: (_frame, connection) => connection.close(1009),
			sse: textEvents("resp_sse", "via http"),
		});
		t.after(() => server.close());
		const model = codexAt(server.url);
		const a = await call(model, { systemPrompt: "Fixture.", tools, messages: [user("big", 1)] }, "ws-big");
		strictEqual(a.message.stopReason, "stop", a.message.errorMessage);
		strictEqual(a.transport?.mode, "sse");
		strictEqual(a.transport?.fallbackActive, false);
		strictEqual(a.transport?.counters?.websocketFailures, 0);
		strictEqual(server.posts, 1);
	});

	test("the public API's frame drops the HTTP-only fields and streams back as SSE", async (t) => {
		const server = await backend({
			onFrame: (_frame, connection) => {
				for (const event of textEvents("resp_public", "hi")) connection.send(event);
			},
		});
		t.after(() => server.close());
		const transport = newTransportCall();
		const fetch = responsesWebSocketFetch({
			flavor: "public",
			base: () => Promise.reject(new Error("no HTTP expected")),
			continuation: true,
			session: "public-1",
			call: transport,
		});
		const response = await fetch(`${server.url}/v1/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test", "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "hi" }], stream: true, store: false }),
		});
		const text = await response.text();
		strictEqual(response.headers.get("content-type"), "text/event-stream");
		ok(text.includes('"response.completed"'), text);
		strictEqual(server.frames[0]?.stream, undefined);
		strictEqual(server.frames[0]?.store, false);
		strictEqual(server.upgrades[0]?.headers["openai-beta"], undefined);
		strictEqual(transport.mode, "websocket");
		strictEqual(transport.counters.connectionsCreated, 1);
	});
});
