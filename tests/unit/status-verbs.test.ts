import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";
import { resolveFooterVerb, resolveInlineVerb } from "../../src/interactive/status/verbs.js";

describe("status/resolveFooterVerb", () => {
	it("idle returns null", () => {
		strictEqual(resolveFooterVerb({ ...INITIAL_STATUS }, 1000, 120), null);
	});

	it("preparing tier 0 on cloud renders preparing", () => {
		const v = resolveFooterVerb(
			{ ...INITIAL_STATUS, phase: "preparing", since: 0, lastMeaningfulAt: 0, localRuntime: false },
			3000,
			120,
		);
		strictEqual(v?.text.includes("preparing"), true);
	});

	it("preparing tier 2 on local renders waiting on model", () => {
		const v = resolveFooterVerb(
			{ ...INITIAL_STATUS, phase: "preparing", since: 0, lastMeaningfulAt: 0, localRuntime: true, watchdogTier: 2 },
			45_000,
			120,
		);
		strictEqual(v?.text.includes("waiting on model"), true);
	});

	it("thinking tier 2 renders still thinking", () => {
		const v = resolveFooterVerb(
			{ ...INITIAL_STATUS, phase: "thinking", since: 0, lastMeaningfulAt: 0, watchdogTier: 2 },
			45_000,
			120,
		);
		strictEqual(v?.text.includes("still thinking"), true);
	});

	it("below 60 cols drops elapsed", () => {
		const v = resolveFooterVerb({ ...INITIAL_STATUS, phase: "thinking", since: 0, lastMeaningfulAt: 0 }, 3000, 55);
		strictEqual(v?.text.includes("3s"), false);
	});

	it("ended uses frozen summary elapsed instead of wall-clock elapsed", () => {
		const v = resolveFooterVerb(
			{
				...INITIAL_STATUS,
				phase: "ended",
				since: 0,
				lastMeaningfulAt: 1000,
				summary: {
					elapsedMs: 1000,
					modelId: "model",
					endpointId: "endpoint",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					toolCount: 0,
					toolErrorCount: 0,
					stopReason: "stop",
					watchdogPeak: 0,
					truncated: false,
				},
			},
			4000,
			120,
		);
		strictEqual(v?.text, "✓ done · 1s");
	});

	it("tier 3 inline adds no progress hint", () => {
		const v = resolveInlineVerb(
			{ ...INITIAL_STATUS, phase: "thinking", since: 0, lastMeaningfulAt: 0, watchdogTier: 3 },
			120_000,
			120,
		);
		strictEqual(v?.text.includes("no progress"), true);
	});

	it("tier 4 inline shows stuck verb", () => {
		const v = resolveInlineVerb(
			{ ...INITIAL_STATUS, phase: "stuck", resumePhase: "thinking", since: 0, lastMeaningfulAt: 0, watchdogTier: 4 },
			200_000,
			120,
		);
		strictEqual(v?.text.includes("Stuck for"), true);
		strictEqual(v?.text.includes("Esc to cancel"), true);
	});
});
