import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	buildCacheCallObservation,
	type CacheCallBaseline,
	type CacheRequestStructure,
} from "../../src/core/cache-telemetry.js";
import type { CallUsage } from "../../src/core/telemetry/schemas.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { foldPromptCacheTelemetry } from "../../src/domains/session/prompt-cache.js";
import { cachePhysics, firstDivergentSection, serverTimedUsage } from "../../src/domains/telemetry/cache-physics.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";

// #423: a break the host cannot name is attributed to the route lifetime it outlived, or to a continuation
// the transport rebuilt, before it is left unknown.

const broken = { input: 10_000, cacheRead: 0, cacheWrite: 0 };
const baseline: CacheCallBaseline = { inclusiveInputTokens: 10_000, endedAt: 0, transportRequest: "delta" };
const websocket = (request: "full" | "delta") => ({ mode: "websocket" as const, request });

test("a break after the route lifetime is idle expiry, and the lifetime is recorded", () => {
	const idle = buildCacheCallObservation(broken, baseline, [], 300_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("delta"),
	});
	strictEqual(idle.cause, "idle_expiry");
	strictEqual(idle.causeBasis, "inferred");
	strictEqual(idle.idleMs, 300_000);
	deepStrictEqual(idle.ttl, { ms: 300_000, source: "declared" });
	deepStrictEqual(idle.transport, websocket("delta"));
	const unknownLifetime = buildCacheCallObservation(broken, baseline, [], 300_000, undefined, { ttlMs: null });
	strictEqual(unknownLifetime.cause, "unknown");
	deepStrictEqual(unknownLifetime.ttl, { ms: null, source: "unknown" });
});

test("a full frame after a delta, or after a transport recovery, is a transport reset", () => {
	const afterDelta = buildCacheCallObservation(broken, baseline, [], 60_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(afterDelta.cause, "transport_reset");
	strictEqual(afterDelta.causeBasis, "host");
	const recovered = buildCacheCallObservation(broken, { ...baseline, transportRequest: "full" }, [], 60_000, undefined, {
		ttlMs: 300_000,
		transport: { mode: "sse", request: "full", reason: "transport_failure", recovery: true },
	});
	strictEqual(recovered.cause, "transport_reset");
	deepStrictEqual(recovered.transport, { mode: "sse", request: "full", reason: "transport_failure" });
	const plainFull = buildCacheCallObservation(broken, { ...baseline, transportRequest: "full" }, [], 60_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(plainFull.cause, "unknown");
});

test("a host-known change outranks both, and a healthy read is never a break", () => {
	const recompiled = buildCacheCallObservation(broken, baseline, ["prompt_recompiled"], 600_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(recompiled.cause, "prompt_recompiled");
	const healthy = buildCacheCallObservation({ ...broken, cacheRead: 9_900 }, baseline, [], 600_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(healthy.cause, "none");
	strictEqual(healthy.idleMs, 600_000);
});

test("the journal names the first divergence in request order and leaves an unreported read unknown (#434)", () => {
	const structure: CacheRequestStructure = { system: "s", tools: "t", entries: ["a", "b"], answered: true };
	strictEqual(firstDivergentSection(structure, { ...structure, entries: ["a", "b", "c"] }), null);
	strictEqual(firstDivergentSection(structure, { ...structure, tools: "u", entries: ["x"] }), "tools");
	strictEqual(firstDivergentSection(structure, { ...structure, entries: ["a", "x", "c"] }), "messages");
	strictEqual(firstDivergentSection(structure, { ...structure, entries: ["a"] }), "messages");
	strictEqual(firstDivergentSection(structure, { ...structure, system: "r" }), "system-prompt");
	const measured = (value: number) => ({ kind: "measured", value, source: "provider" }) as const;
	const usage = (cacheRead: CallUsage["cacheRead"]): CallUsage => ({
		input: measured(4_000),
		output: measured(10),
		cacheRead,
		cacheWrite: measured(0),
		cacheWrite1h: measured(0),
		reasoning: measured(0),
	});
	const pricing = { rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, provenance: "known" } as const;
	const previous = { structure, promptTokens: 10_000 };
	const broke = cachePhysics({
		settlement: { disposition: "settled", usage: usage(measured(7_000)) },
		structure,
		previous,
		pricing,
	});
	deepStrictEqual(broke.cache.rePrefilledTokens, { kind: "measured", value: 3_000, source: "local-count" });
	strictEqual(broke.baseline?.promptTokens, 11_000);
	const omitted = cachePhysics({
		settlement: { disposition: "settled", usage: usage({ kind: "unknown", reason: "provider-omitted" }) },
		structure,
		previous,
		pricing,
	});
	deepStrictEqual(omitted.cache.rePrefilledTokens, { kind: "unknown", reason: "provider-omitted" });
	deepStrictEqual(omitted.cache.bill, { usd: { kind: "unknown", reason: "provider-omitted" }, pricedBy: "none" });
	strictEqual(omitted.baseline?.promptTokens, null);
	// A request carrying an earlier reply that this process never saw has no baseline to compare with.
	const resumed = cachePhysics({
		settlement: { disposition: "settled", usage: usage(measured(0)) },
		structure,
		previous: undefined,
		pricing,
	});
	deepStrictEqual(resumed.cache.rePrefilledTokens, { kind: "unknown", reason: "not-observed" });
});

test("a server whose usage omits cache reads is judged by its own cache_n, and its usage facts stand (#434)", () => {
	const settlement = callSettlementFromMessage(
		{
			role: "assistant",
			stopReason: "stop",
			usage: { input: 10_000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10_005, cacheReadReported: false },
		},
		"known_free",
	);
	// The usage's input is the whole prompt, so it is no uncached prefill without a measured read beside it.
	deepStrictEqual(settlement.usage?.input, { kind: "measured", value: 10_000, source: "provider" });
	deepStrictEqual(settlement.usage?.cacheRead, { kind: "unknown", reason: "provider-omitted" });
	deepStrictEqual(settlement.cache.uncachedPrefillTokens, { kind: "unknown", reason: "provider-omitted" });
	const backend = {
		promptTokens: 10_000,
		cachedTokens: 6_000,
		predictedTokens: 5,
		promptMs: 120,
		predictedMs: 40,
		source: "llamacpp-timings",
	} as const;
	const timed = serverTimedUsage(settlement, backend);
	deepStrictEqual(
		[timed?.input, timed?.cacheRead, timed?.cacheWrite],
		[4_000, 6_000, 0].map((value) => ({ kind: "measured", value, source: "provider" })),
	);
	const structure: CacheRequestStructure = { system: "s", tools: "t", entries: ["a", "b"], answered: true };
	const physics = cachePhysics({
		settlement: { ...settlement, usage: timed ?? null },
		structure,
		previous: { structure, promptTokens: 9_000 },
		pricing: { rates: null, provenance: "known_free" },
	});
	deepStrictEqual(physics.cache.rePrefilledTokens, { kind: "measured", value: 3_000, source: "local-count" });
	strictEqual(physics.baseline?.promptTokens, 10_000);
	strictEqual(serverTimedUsage(settlement, { ...backend, cachedTokens: null }), undefined);
	strictEqual(serverTimedUsage({ ...settlement, disposition: "sent_unsettled" }, backend), undefined);
	const read = { ...settlement, usage: timed ?? null };
	strictEqual(serverTimedUsage(read, backend), undefined, "a measured read is the provider's and stands");
});

test("an omitted cache read leaves the shortfall unknown and is never a break, in new and old ledger rows (#434)", () => {
	const omitted = buildCacheCallObservation({ input: 10_000, cacheRead: null, cacheWrite: 0 }, baseline, [], 60_000);
	strictEqual(omitted.shortfallTokens, null);
	strictEqual(omitted.cacheReadTokens, null);
	strictEqual(omitted.cause, "none");
	const legacy = buildCacheCallObservation(broken, baseline, [], 60_000);
	const row = (backendVerdict: string, observation: unknown) =>
		({
			kind: "message",
			role: "assistant",
			payload: { promptCache: { backendVerdict, observation } },
		}) as unknown as SessionEntry;
	const folded = foldPromptCacheTelemetry([row("unknown", legacy), row("unknown", omitted)]);
	strictEqual(folded.reprefilledTokens, null);
	strictEqual(folded.cacheBreakCalls, 0);
	strictEqual(foldPromptCacheTelemetry([row("cold", legacy)]).cacheBreakCalls, 1);
});
