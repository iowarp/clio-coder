import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	buildCtxBar,
	contextSegment,
	dispatchSegment,
	fitFooterText,
	formatFooterTokens,
	throughputDetailSegment,
	throughputSegment,
	tokensSegment,
} from "../../src/interactive/footer-panel.js";

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
		strictEqual((segment as string).includes("Σ2k"), true);
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
		strictEqual(segment, "↑100 ↓200 r64 Σ300");
	});
});

describe("throughputSegment", () => {
	it("renders final token throughput compactly", () => {
		strictEqual(
			throughputSegment({
				tokensPerSecond: 42.4,
				outputTokens: 120,
				durationMs: 2830,
				providerId: "mini",
				modelId: "gemma-4-12b-q4-code-256k",
				recordedAt: 1,
			}),
			"⚡42 Tk/s",
		);
		strictEqual(
			throughputSegment({
				tokensPerSecond: 7.26,
				outputTokens: 4,
				durationMs: 551,
				providerId: "mini",
				modelId: "gemma-4-12b-q4-code-256k",
				recordedAt: 1,
			}),
			"⚡7.3 Tk/s",
		);
		strictEqual(throughputSegment(null), null);
	});

	it("renders final token throughput details for the expanded dashboard", () => {
		strictEqual(
			throughputDetailSegment({
				tokensPerSecond: 42.4,
				outputTokens: 1200,
				durationMs: 2830,
				ttftMs: 640,
				providerId: "mini",
				modelId: "gemma-4-12b-q4-code-256k",
				recordedAt: 1,
			}),
			"gen 2.8s · ttft 640ms · ↓1.2k",
		);
		strictEqual(throughputDetailSegment(null), null);
	});
});

describe("contextSegment", () => {
	it("formats context usage as a compact percent label", () => {
		strictEqual(buildCtxBar(50), "████░░░░");
		const segment = contextSegment({ tokens: 32_000, contextWindow: 128_000, percent: 25 });
		strictEqual(segment, "ctx ███░░░░░░░ 25%");
	});

	it("keeps unknown usage visible when the context window is known", () => {
		const segment = contextSegment({ tokens: null, contextWindow: 8192, percent: null });
		strictEqual(segment, "ctx ░░░░░░░░░░ ?%");
	});

	it("suppresses context when no context window is available", () => {
		strictEqual(contextSegment({ tokens: 12, contextWindow: 0, percent: null }), null);
	});
});

describe("dispatchSegment", () => {
	it("summarizes active, completed, failed, and token counts from dispatch rows", () => {
		const segment = dispatchSegment([
			{
				runId: "run-1",
				agentId: "coder",
				runtimeKind: "http",
				runtimeId: "openai",
				endpointId: "local",
				wireModelId: "qwen",
				status: "running",
				elapsedMs: 10,
				tokenCount: 1000,
				costUsd: 0,
			},
			{
				runId: "run-2",
				agentId: "reviewer",
				runtimeKind: "sdk",
				runtimeId: "claude",
				endpointId: "remote",
				wireModelId: "sonnet",
				status: "completed",
				elapsedMs: 20,
				tokenCount: 2000,
				costUsd: 0,
			},
			{
				runId: "run-3",
				agentId: "debugger",
				runtimeKind: "subprocess",
				runtimeId: "codex",
				endpointId: "codex",
				wireModelId: "gpt",
				status: "dead",
				elapsedMs: 30,
				tokenCount: 500,
				costUsd: 0,
			},
		]);
		strictEqual(segment, "dispatch 1 active 1 done 1 fail 3.5ktok");
	});

	it("suppresses dispatch metadata until at least one row exists", () => {
		strictEqual(dispatchSegment([]), null);
	});
});

describe("fitFooterText", () => {
	it("truncates footer text to the terminal width using visible width", () => {
		const line = fitFooterText("Clio Coder · [DEFAULT] · endpoint/model · CTX 95% ████████", 32);
		strictEqual(visibleWidth(line) <= 32, true);
	});
});
