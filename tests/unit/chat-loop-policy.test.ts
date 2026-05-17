import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RETRY_SETTINGS } from "../../src/domains/session/retry.js";
import { normalizeRetrySettings } from "../../src/interactive/chat-loop-policy.js";

describe("interactive/chat-loop retry policy", () => {
	it("uses retry defaults when settings are absent", () => {
		deepStrictEqual(normalizeRetrySettings(undefined), DEFAULT_RETRY_SETTINGS);
		deepStrictEqual(normalizeRetrySettings(null), DEFAULT_RETRY_SETTINGS);
	});

	it("normalizes numeric retry fields to non-negative integers", () => {
		deepStrictEqual(normalizeRetrySettings({ enabled: false, maxRetries: 2.9, baseDelayMs: 10.8, maxDelayMs: -3 }), {
			enabled: false,
			maxRetries: 2,
			baseDelayMs: 10,
			maxDelayMs: 0,
		});
	});

	it("falls back for non-finite numeric retry fields", () => {
		deepStrictEqual(
			normalizeRetrySettings({
				maxRetries: Number.NaN,
				baseDelayMs: Number.POSITIVE_INFINITY,
				maxDelayMs: Number.NEGATIVE_INFINITY,
			}),
			{
				enabled: DEFAULT_RETRY_SETTINGS.enabled,
				maxRetries: DEFAULT_RETRY_SETTINGS.maxRetries,
				baseDelayMs: DEFAULT_RETRY_SETTINGS.baseDelayMs,
				maxDelayMs: DEFAULT_RETRY_SETTINGS.maxDelayMs,
			},
		);
	});
});
