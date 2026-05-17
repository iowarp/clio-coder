import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedThinkingCapability } from "../../src/domains/providers/index.js";
import { formatFooterTokens, thinkingSuffixForFooter, tokensSegment } from "../../src/interactive/footer-panel.js";

function thinking(overrides: Partial<ResolvedThinkingCapability>): ResolvedThinkingCapability {
	return {
		thinkingActive: false,
		mechanism: "none",
		noticeKind: "applied",
		notice: "",
		configuredLevel: "off",
		effectiveLevel: "off",
		supportedLevels: ["off"],
		display: "off",
		budgetEnforcement: "none",
		...overrides,
	};
}

describe("formatFooterTokens", () => {
	it("renders 0 and small values without a suffix", () => {
		strictEqual(formatFooterTokens(0), "0");
		strictEqual(formatFooterTokens(12), "12");
		strictEqual(formatFooterTokens(999), "999");
	});
	it("rolls over to k at 1,000 with decimal trimming", () => {
		strictEqual(formatFooterTokens(1000), "1k");
		strictEqual(formatFooterTokens(1499), "1.5k");
		strictEqual(formatFooterTokens(12_345), "12.3k");
	});
	it("rolls over to M at 1,000,000", () => {
		strictEqual(formatFooterTokens(1_000_000), "1M");
		strictEqual(formatFooterTokens(2_500_000), "2.5M");
	});
	it("treats negatives and non-finite as 0", () => {
		strictEqual(formatFooterTokens(-1), "0");
		strictEqual(formatFooterTokens(Number.NaN), "0");
		strictEqual(formatFooterTokens(Number.POSITIVE_INFINITY), "0");
	});
});

describe("tokensSegment", () => {
	it("returns null when usage is missing or all-zero", () => {
		strictEqual(tokensSegment(undefined), null);
		strictEqual(tokensSegment(null), null);
		strictEqual(
			tokensSegment({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
			null,
		);
	});
	it("renders an ↑input ↓output counter for a populated breakdown", () => {
		const segment = tokensSegment({
			input: 1234,
			output: 567,
			cacheRead: 200,
			cacheWrite: 0,
			reasoningTokens: 0,
			totalTokens: 2001,
		});
		strictEqual(typeof segment, "string");
		// Shape: ↑<formatted-input> <space> ↓<formatted-output>. Assert both
		// arrows and both formatted counts appear so the footer reliably
		// surfaces up/down token deltas during a run.
		strictEqual((segment as string).includes("↑1.2k"), true);
		strictEqual((segment as string).includes("↓567"), true);
	});
	it("renders counters even when input/output are 0 but totalTokens is positive", () => {
		// Dispatch-run usage only fills totalTokens (no per-kind breakdown).
		// The footer should still show a segment rather than hide entirely.
		const segment = tokensSegment({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 0,
			totalTokens: 500,
		});
		strictEqual(typeof segment, "string");
		strictEqual((segment as string).includes("↑0"), true);
		strictEqual((segment as string).includes("↓0"), true);
	});
	it("renders reasoning tokens when providers expose them", () => {
		const segment = tokensSegment({
			input: 100,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 64,
			totalTokens: 300,
		});
		strictEqual(segment, "↑100 ↓200 r64");
	});
});

describe("thinkingSuffixForFooter", () => {
	it("renders on/off models with display semantics instead of raw levels", () => {
		const suffix = thinkingSuffixForFooter(
			thinking({
				thinkingActive: true,
				mechanism: "on-off",
				configuredLevel: "high",
				effectiveLevel: "low",
				supportedLevels: ["off", "low"],
				display: "on",
			}),
		);

		strictEqual(suffix.includes("◆ on"), true);
		strictEqual(suffix.includes("high"), false);
	});

	it("renders Harmony effort levels directly from the resolved display", () => {
		const suffix = thinkingSuffixForFooter(
			thinking({
				thinkingActive: true,
				mechanism: "effort-levels",
				configuredLevel: "off",
				effectiveLevel: "low",
				supportedLevels: ["low", "medium", "high"],
				display: "low",
			}),
		);

		strictEqual(suffix.includes("◆ low"), true);
		strictEqual(suffix.includes("off"), false);
	});
});
