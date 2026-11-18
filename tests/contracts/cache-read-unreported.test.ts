import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { unreportedCacheReadWords } from "../../src/core/telemetry/render.js";

const sum = (measured: number, unknown: number) => ({
	measured: 0,
	estimated: 0,
	unknownCount: unknown,
	absentCount: 0,
	coverage: { measured, estimated: 0, unknown },
});

test("cache reads a provider left unreported are named as unmeasured, never as a miss", () => {
	strictEqual(
		unreportedCacheReadWords(sum(0, 24)),
		"no call reported a cache read (24 calls); reuse is unmeasured, not a miss",
	);
	strictEqual(
		unreportedCacheReadWords(sum(3, 1)),
		"1 of 4 calls reported no cache read; the cached share marks them ≥, or ~ where the server timed its uncached prefill",
	);
	strictEqual(unreportedCacheReadWords(sum(5, 0)), null);
	strictEqual(unreportedCacheReadWords({ kind: "measured", value: 0, source: "provider" }), null);
});
