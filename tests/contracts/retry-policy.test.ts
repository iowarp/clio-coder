import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeRetryDelayMs,
	DEFAULT_RETRY_SETTINGS,
	isModelLoadingErrorMessage,
	isRetryableErrorMessage,
} from "../../src/domains/session/retry.js";

describe("contracts/retry-policy", () => {
	it("still classifies ordinary provider transients as retryable", () => {
		for (const message of [
			"Overloaded",
			"429 rate limited",
			"503 Service Unavailable",
			"fetch failed",
			"socket hang up",
		]) {
			ok(isRetryableErrorMessage(message), `${message} must retry`);
			strictEqual(isModelLoadingErrorMessage(message), false, `${message} is not a model load`);
		}
	});

	/**
	 * Measured against LM Studio serving an evicted model over openai-compat:
	 * the first request answers `500 Internal Server Error`, the next answers
	 * the bare string `Model is unloaded.` while the load runs. The second was
	 * not in the retryable pattern at all, so `clio-coder run --target dynamo --model
	 * qwopus3.6-35b-a3b-coder-mtp` gave up after two attempts in six seconds
	 * and printed the server's error where the answer belongs.
	 */
	it("treats a not-resident model as retryable across the runtimes that phrase it differently", () => {
		for (const message of [
			"Model is unloaded.",
			"model is loading",
			"No model loaded",
			"model not loaded",
			"loading model qwen3-coder",
		]) {
			ok(isRetryableErrorMessage(message), `${message} must retry`);
			ok(isModelLoadingErrorMessage(message), `${message} must read as a model load`);
		}
	});

	it("does not retry a real configuration error", () => {
		for (const message of ["model_not_found", "invalid api key", "unknown model 'typo'"]) {
			strictEqual(isRetryableErrorMessage(message), false, `${message} must not retry`);
		}
	});

	/**
	 * A 35B model loads off disk in tens of seconds. The rate-limit schedule
	 * (2s, 4s, 8s) spends every attempt inside the load window, so the wait has
	 * a floor when the error says a load is what we are waiting for.
	 */
	it("waits long enough for a load instead of on a rate limit's schedule", () => {
		const rateLimited = computeRetryDelayMs(1, DEFAULT_RETRY_SETTINGS, "429 rate limited");
		strictEqual(rateLimited, 2000);

		const loading = computeRetryDelayMs(1, DEFAULT_RETRY_SETTINGS, "Model is unloaded.");
		ok(loading >= 15000, `first load retry waited ${loading}ms`);

		const total = [1, 2, 3].reduce(
			(sum, attempt) => sum + computeRetryDelayMs(attempt, DEFAULT_RETRY_SETTINGS, "Model is unloaded."),
			0,
		);
		ok(total >= 45000, `three attempts must span a real load window, got ${total}ms`);
	});

	it("keeps maxDelayMs authoritative so an operator who wants short waits gets them", () => {
		const impatient = { ...DEFAULT_RETRY_SETTINGS, maxDelayMs: 3000 };
		strictEqual(computeRetryDelayMs(1, impatient, "Model is unloaded."), 3000);
	});

	it("returns false for an absent error message rather than retrying blind", () => {
		strictEqual(isRetryableErrorMessage(null), false);
		strictEqual(isRetryableErrorMessage(""), false);
		strictEqual(isModelLoadingErrorMessage(undefined), false);
	});
});
