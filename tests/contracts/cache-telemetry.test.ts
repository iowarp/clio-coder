import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildCacheCallObservation, type CacheCallBaseline } from "../../src/core/cache-telemetry.js";

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
