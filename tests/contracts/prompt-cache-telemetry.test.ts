import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { BackendCompletionTimings } from "../../src/core/cache-telemetry.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import {
	foldPromptCacheTelemetry,
	hasPromptCacheTelemetry,
	topExpectedColdReason,
} from "../../src/domains/session/prompt-cache.js";

function assistant(
	turnId: string,
	promptCache?: {
		backend?: BackendCompletionTimings | Record<string, unknown>;
		backendVerdict?: string;
		expectedColdReasons?: string[];
	},
): SessionEntry {
	return {
		kind: "message",
		role: "assistant",
		turnId,
		parentTurnId: null,
		timestamp: `2026-08-29T00:00:0${turnId.length}.000Z`,
		payload: promptCache === undefined ? { text: "done" } : { text: "done", promptCache },
	};
}

function backend(promptTokens: number, cachedTokens: number | null): BackendCompletionTimings {
	return {
		promptTokens,
		cachedTokens,
		predictedTokens: 12,
		promptMs: 45,
		predictedMs: 30,
		source: "llamacpp-timings",
	};
}

describe("contracts/prompt-cache telemetry fold", () => {
	it("distinguishes absent cache-read evidence from an authoritative zero", () => {
		const absent = foldPromptCacheTelemetry([assistant("absent")]);
		strictEqual(absent.uncachedPrefillTokens, null);
		strictEqual(absent.uncachedPrefillCalls, 0);
		strictEqual(hasPromptCacheTelemetry(absent), false);

		const fullyCached = foldPromptCacheTelemetry([
			assistant("hot", { backend: backend(12_000, 12_000), backendVerdict: "hot" }),
		]);
		strictEqual(fullyCached.uncachedPrefillTokens, 0);
		strictEqual(fullyCached.uncachedPrefillCalls, 1);
		strictEqual(fullyCached.verdictCounts.hot, 1);
		strictEqual(hasPromptCacheTelemetry(fullyCached), true);
	});

	it("sums backend-reported uncached prefill and counts persisted verdicts", () => {
		const telemetry = foldPromptCacheTelemetry([
			assistant("cold", { backend: backend(8_000, 0), backendVerdict: "cold" }),
			assistant("partial", { backend: backend(10_000, 7_500), backendVerdict: "partial" }),
			assistant("unknown", { backend: backend(4_000, null), backendVerdict: "small" }),
			assistant("invalid-verdict", { backendVerdict: "lukewarm" }),
		]);

		strictEqual(telemetry.uncachedPrefillTokens, 10_500);
		strictEqual(telemetry.uncachedPrefillCalls, 2);
		strictEqual(telemetry.verdictCalls, 3);
		deepStrictEqual(telemetry.verdictCounts, { hot: 0, partial: 1, cold: 1, small: 1 });
	});

	it("rejects malformed timing payloads instead of inventing prefill work", () => {
		const telemetry = foldPromptCacheTelemetry([
			assistant("too-many-cached", {
				backend: { ...backend(1_000, 1_001) },
				backendVerdict: "hot",
			}),
			assistant("negative", {
				backend: { ...backend(1_000, 0), promptMs: -1 },
				backendVerdict: "cold",
			}),
		]);

		strictEqual(telemetry.uncachedPrefillTokens, null);
		strictEqual(telemetry.uncachedPrefillCalls, 0);
		deepStrictEqual(telemetry.verdictCounts, { hot: 1, partial: 0, cold: 1, small: 0 });
	});

	it("counts each expected reason once per call and breaks top-reason ties deterministically", () => {
		const telemetry = foldPromptCacheTelemetry([
			assistant("one", {
				backendVerdict: "cold",
				expectedColdReasons: ["residency", "residency", "thinking_change"],
			}),
			assistant("two", {
				backendVerdict: "cold",
				expectedColdReasons: ["thinking_change", "residency"],
			}),
		]);

		deepStrictEqual(telemetry.expectedColdReasonCounts, { residency: 2, thinking_change: 2 });
		deepStrictEqual(topExpectedColdReason(telemetry), { reason: "residency", count: 2 });
	});
});
