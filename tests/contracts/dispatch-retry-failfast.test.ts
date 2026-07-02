import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeterministicWorkerFailure } from "../../src/domains/dispatch/backoff.js";

describe("contracts/dispatch retry fail-fast classifier", () => {
	it("matches the reconciler's will-not-fit message shapes", () => {
		ok(
			isDeterministicWorkerFailure(
				"'qwopus3.6-27b' needs ~24.1 GiB of VRAM but only 9.3 GiB is available on 'dynamo-fleet' at context 262144. Lower the context window, use a smaller KV-cache quant, or pick a smaller model or tier.",
			),
		);
		ok(isDeterministicWorkerFailure("model load failed: VRAM fit check failed"));
	});

	it("leaves transient and unknown failures retryable", () => {
		strictEqual(isDeterministicWorkerFailure("connection refused"), false);
		strictEqual(isDeterministicWorkerFailure("rate limited: 429"), false);
		strictEqual(isDeterministicWorkerFailure("exit code 1"), false);
		strictEqual(isDeterministicWorkerFailure(""), false);
		strictEqual(isDeterministicWorkerFailure(null), false);
		strictEqual(isDeterministicWorkerFailure(undefined), false);
	});
});
