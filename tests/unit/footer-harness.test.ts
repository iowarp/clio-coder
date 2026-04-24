import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { formatFooterTokens, formatHarnessIndicator, tokensSegment } from "../../src/interactive/footer-panel.js";

describe("formatHarnessIndicator", () => {
	it("returns null for idle", () => {
		strictEqual(formatHarnessIndicator({ kind: "idle" }), null);
	});
	it("formats hot-ready", () => {
		const line = formatHarnessIndicator({ kind: "hot-ready", message: "read.ts (14ms)", until: 0 });
		strictEqual(typeof line, "string");
		strictEqual((line as string).includes("read.ts"), true);
	});
	it("formats restart-required with file count", () => {
		const line = formatHarnessIndicator({
			kind: "restart-required",
			files: ["src/domains/session/manifest.ts", "src/engine/agent.ts"],
		});
		strictEqual((line as string).includes("restart"), true);
		strictEqual((line as string).includes("Ctrl+R"), true);
	});
	it("formats worker-pending with count", () => {
		const line = formatHarnessIndicator({ kind: "worker-pending", count: 3 });
		strictEqual((line as string).includes("3"), true);
	});
	it("formats hot-failed with message", () => {
		const line = formatHarnessIndicator({ kind: "hot-failed", message: "edit.ts: syntax error", until: 0 });
		strictEqual((line as string).includes("edit.ts"), true);
	});
});

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
		strictEqual(tokensSegment({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }), null);
	});
	it("renders an ↑input ↓output counter for a populated breakdown", () => {
		const segment = tokensSegment({
			input: 1234,
			output: 567,
			cacheRead: 200,
			cacheWrite: 0,
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
			totalTokens: 500,
		});
		strictEqual(typeof segment, "string");
		strictEqual((segment as string).includes("↑0"), true);
		strictEqual((segment as string).includes("↓0"), true);
	});
});
