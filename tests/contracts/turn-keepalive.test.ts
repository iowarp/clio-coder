/** Hosted prompt-cache keepalive (#423): which routes refresh, when, and when the turn's wait is not Clio's. */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import {
	type CacheKeepaliveReply,
	type CacheKeepaliveRequest,
	cacheKeepaliveOptions,
	cacheKeepaliveRoute,
} from "../../src/engine/cache-keepalive.js";
import type { EngineModel } from "../../src/engine/types.js";
import {
	createTurnKeepalive,
	type KeepaliveRefresh,
	type TurnKeepaliveDeps,
} from "../../src/session-control/turn-keepalive.js";
import type { AgentRuntime } from "../../src/session-control/turn-state.js";

function model(api: string, overrides: Partial<EngineModel> = {}): EngineModel {
	return {
		id: "fixture",
		name: "fixture",
		api,
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		...overrides,
	} as EngineModel;
}

const claude = model("anthropic-messages", { promptCache: { short: 300, long: 3600 } });
const request = (m: EngineModel): CacheKeepaliveRequest => ({ model: m, context: { messages: [] }, options: {} });
const reply = (input: number, cacheRead: number): CacheKeepaliveReply => ({
	stopReason: "stop",
	usage: {
		input,
		output: 1,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + cacheRead + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

function harness(overrides: Partial<TurnKeepaliveDeps> = {}) {
	let clock = 0;
	const pending: Array<{ at: number; fire: () => void }> = [];
	const refreshes: KeepaliveRefresh[] = [];
	const runtime = { runtimeResolution: { costProvenance: "estimated" } } as unknown as AgentRuntime;
	const keepalive = createTurnKeepalive({
		enabled: () => true,
		isTurnActive: () => true,
		waitsOnOperator: () => false,
		hasAttachedDispatch: () => true,
		isCurrentRuntime: () => true,
		canSpend: () => true,
		record: (_runtime, refresh) => refreshes.push(refresh),
		replay: async () => reply(0, 200_000),
		now: () => clock,
		timers: {
			set: (fire, ms) => {
				const entry = { at: clock + ms, fire };
				pending.push(entry);
				return entry;
			},
			clear: (handle) => {
				const index = pending.indexOf(handle as (typeof pending)[number]);
				if (index >= 0) pending.splice(index, 1);
			},
		},
		...overrides,
	});
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
	/** Advance to the next armed timer and let its refresh finish. */
	const advance = async (): Promise<number | null> => {
		const next = pending.shift();
		if (!next) return null;
		clock = next.at;
		next.fire();
		await settle();
		return next.at;
	};
	const follow = async (m: EngineModel) => {
		keepalive.noteRequest(runtime, request(m), { result: async () => reply(150_000, 50_000) });
		await settle();
	};
	return { keepalive, refreshes, advance, follow };
}

test("routes refresh only where the output is capped and the cache lifetime is known", () => {
	deepStrictEqual(cacheKeepaliveRoute(request(claude)), { ok: true, ttlMs: 300_000, delayMs: 270_000, outputTokens: 1 });
	const responses = cacheKeepaliveRoute(request(model("openai-responses")));
	deepStrictEqual(responses, { ok: true, ttlMs: 300_000, delayMs: 270_000, outputTokens: 16 });
	const extended = cacheKeepaliveRoute({ ...request(model("openai-responses")), options: { cacheRetention: "long" } });
	strictEqual(extended.ok && extended.ttlMs, 24 * 60 * 60_000);
	// Codex rejects retention but takes a body cap (measured 2026-10-30, #423), at OpenAI's documented floor.
	deepStrictEqual(cacheKeepaliveRoute(request(model("openai-codex-responses"))), {
		ok: true,
		ttlMs: 300_000,
		delayMs: 270_000,
		outputTokens: 16,
	});
	deepStrictEqual(cacheKeepaliveRoute(request(model("openai-completions"))), { ok: false, reason: "lifetime-unknown" });
	deepStrictEqual(cacheKeepaliveRoute({ ...request(claude), options: { cacheRetention: "none" } }), {
		ok: false,
		reason: "retention-none",
	});
});

test("a turn awaiting an attached dispatch refreshes its prefix before each expiry and books every refresh", async () => {
	const run = harness();
	await run.follow(claude);
	strictEqual(await run.advance(), 270_000);
	strictEqual(await run.advance(), 540_000);
	strictEqual(run.refreshes.length, 2);
	const first = run.refreshes[0];
	ok(first);
	strictEqual(first.phase, "fleet");
	strictEqual(first.promptTokens, 200_000);
	ok(first.economics.expectedSavingsUsd >= 0.05);
	strictEqual(run.keepalive.stopReason(), null);
});

test("a Codex refresh carries max_output_tokens on the body after the turn's own payload edits", async () => {
	const codex = model("openai-codex-responses");
	const turn: CacheKeepaliveRequest = {
		model: codex,
		context: { messages: [] },
		options: { onPayload: async (payload) => ({ ...(payload as object), tool_choice: "auto" }) },
	};
	const options = cacheKeepaliveOptions(turn, 16, new AbortController().signal);
	strictEqual(options.maxRetries, 0);
	deepStrictEqual(await options.onPayload?.({ input: [] }, codex), {
		input: [],
		tool_choice: "auto",
		max_output_tokens: 16,
	});
	strictEqual(cacheKeepaliveOptions(request(claude), 1, new AbortController().signal).onPayload, undefined);
});

test("the keepalive stands down without a known lifetime, for cheap prefixes, settled turns and waits a person owns", async () => {
	const unknown = harness();
	await unknown.follow(model("openai-completions"));
	strictEqual(await unknown.advance(), null);
	strictEqual(unknown.keepalive.stopReason(), "lifetime-unknown");

	const cheap = harness();
	await cheap.follow(
		model("anthropic-messages", {
			promptCache: { short: 300 },
			cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		}),
	);
	await cheap.advance();
	strictEqual(cheap.refreshes.length, 0);
	strictEqual(cheap.keepalive.stopReason(), "below-threshold");

	const settled = harness({ isTurnActive: () => false });
	await settled.follow(claude);
	await settled.advance();
	strictEqual(settled.keepalive.stopReason(), "turn-settled");

	const asked = harness({ waitsOnOperator: () => true });
	await asked.follow(claude);
	await asked.advance();
	strictEqual(asked.refreshes.length, 0);
	strictEqual(asked.keepalive.stopReason(), "operator-wait");
});

test("a journaled refresh carries its call identity so legacy accounting skips it (#434)", async () => {
	const records: PendingTelemetry[] = [];
	const unregister = registerTelemetrySink("keepalive-session", { enqueue: (record) => records.push(record) > 0 });
	try {
		const run = harness({
			callJournal: () => ({
				origin: { id: "keepalive-session", cwdHash: "fixture" },
				acquire: async () => ({ context: { sessionId: "keepalive-session", label: "prewarm" }, release: async () => {} }),
				label: "prewarm",
				targetId: "fixture-target",
				runtimeId: "fixture-runtime",
				costProvenance: "estimated",
			}),
		});
		await run.follow(claude);
		await run.advance();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const call = run.refreshes[0]?.call;
		ok(call);
		deepStrictEqual(
			records.map((record) => [record.kind, record.ctx.callId, record.ctx.label]),
			[
				["call.started", call.callId, "prewarm"],
				["call.settled", call.callId, "prewarm"],
			],
		);
	} finally {
		unregister();
	}
});
