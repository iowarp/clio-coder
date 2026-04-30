import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createObservabilityBundle } from "../../src/domains/observability/extension.js";
import { sumRunUsage } from "../../src/interactive/chat-loop.js";
import { aggregateCostEntries, buildCostSnapshot, formatCostOverlayLines } from "../../src/interactive/cost-overlay.js";

function stubDomainContext(): DomainContext & { bus: ReturnType<typeof createSafeEventBus> } {
	const bus = createSafeEventBus();
	return {
		bus,
		getContract: (() => undefined) as DomainContext["getContract"],
	};
}

function assistantMessageWithUsage(input: number, output: number, costTotal: number): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
		},
	};
}

describe("sumRunUsage", () => {
	it("sums tokens and cost across every assistant message in a run", () => {
		// pi-agent-core emits one AssistantMessage per API call, so a
		// multi-turn tool-calling run has several. The previous tail-only
		// reader silently dropped every intermediate call; this test locks
		// the summing behavior so the /cost overlay stops undercounting.
		const messages = [
			assistantMessageWithUsage(1000, 200, 0.01),
			{ role: "toolResult", content: [], isError: false, timestamp: 0, toolCallId: "t1", toolName: "bash" },
			assistantMessageWithUsage(300, 90, 0.003),
			assistantMessageWithUsage(150, 40, 0.001),
		];
		const summary = sumRunUsage(messages as never);
		strictEqual(summary.hadUsage, true);
		strictEqual(summary.input, 1450);
		strictEqual(summary.output, 330);
		strictEqual(summary.tokens, 1780);
		// Cost arithmetic on floats. Compare with tolerance in one digit.
		strictEqual(Math.round(summary.costUsd * 1000) / 1000, 0.014);
	});

	it("returns an empty summary when no assistant message carries usage", () => {
		const messages = [
			{ role: "user", content: "hi", timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 0 },
		];
		const summary = sumRunUsage(messages as never);
		strictEqual(summary.hadUsage, false);
		strictEqual(summary.tokens, 0);
		strictEqual(summary.costUsd, 0);
	});

	it("falls back to input+output+cache when totalTokens is missing", () => {
		const messages = [
			{
				role: "assistant",
				content: [],
				stopReason: "stop",
				timestamp: 0,
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
			},
		];
		const summary = sumRunUsage(messages as never);
		strictEqual(summary.tokens, 165);
		strictEqual(summary.input, 100);
		strictEqual(summary.output, 50);
		strictEqual(summary.cacheRead, 10);
		strictEqual(summary.cacheWrite, 5);
	});

	it("tracks reasoning tokens when a provider exposes them", () => {
		const messages = [
			{
				role: "assistant",
				content: [],
				stopReason: "stop",
				timestamp: 0,
				usage: { input: 100, output: 50, output_tokens_details: { reasoning_tokens: 12 } },
			},
		];
		const summary = sumRunUsage(messages as never);
		strictEqual(summary.hadReasoning, true);
		strictEqual(summary.reasoning, 12);
	});
});

describe("aggregateCostEntries", () => {
	it("groups by provider::model and sums runs, tokens, and usd", () => {
		const rows = aggregateCostEntries([
			{ providerId: "a", modelId: "m1", tokens: 100, usd: 0.01, input: 60, output: 40, cacheRead: 0, cacheWrite: 0 },
			{ providerId: "a", modelId: "m1", tokens: 200, usd: 0.02, input: 120, output: 80, cacheRead: 0, cacheWrite: 0 },
			{ providerId: "b", modelId: "m2", tokens: 50, usd: 0, input: 25, output: 25, cacheRead: 0, cacheWrite: 0 },
		]);
		strictEqual(rows.length, 2);
		const aRow = rows.find((r) => r.providerId === "a");
		strictEqual(aRow?.runs, 2);
		strictEqual(aRow?.tokens, 300);
		strictEqual(Math.round((aRow?.usd ?? 0) * 1000) / 1000, 0.03);
	});
});

describe("observability sessionTokens / sessionCost / cost overlay", () => {
	it("records breakdown through recordTokens and surfaces it via sessionTokens", async () => {
		const context = stubDomainContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();
		try {
			bundle.contract.recordTokens("anthropic", "claude-opus-4-7", 1780, 0.014, {
				input: 1450,
				output: 330,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1780,
			});
			bundle.contract.recordTokens("openai", "gpt-5.3", 600, 0.006, {
				input: 500,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 600,
			});

			const tokens = bundle.contract.sessionTokens();
			deepStrictEqual(tokens, {
				input: 1950,
				output: 430,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2380,
			});
			strictEqual(Math.round(bundle.contract.sessionCost() * 1000) / 1000, 0.02);

			const snapshot = buildCostSnapshot(bundle.contract, "sess-1");
			strictEqual(snapshot.totalTokens, 2380);
			strictEqual(snapshot.rows.length, 2);
			// Rows are sorted by provider then model; assert both are present
			// with correct per-row math.
			const anthropic = snapshot.rows.find((r) => r.providerId === "anthropic");
			strictEqual(anthropic?.tokens, 1780);
			strictEqual(Math.round((anthropic?.usd ?? 0) * 1000) / 1000, 0.014);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("formats the overlay with a total header and per-row cells", () => {
		const lines = formatCostOverlayLines(
			0.02,
			2380,
			[
				{ providerId: "anthropic", modelId: "claude-opus-4-7", runs: 1, tokens: 1780, usd: 0.014 },
				{ providerId: "openai", modelId: "gpt-5.3", runs: 1, tokens: 600, usd: 0.006 },
			],
			{ sessionId: "sess-1" },
		);
		const joined = lines.join("\n");
		strictEqual(joined.includes("$0.02"), true);
		strictEqual(joined.includes("2,380 tokens"), true);
		strictEqual(joined.includes("claude-opus-4-7"), true);
		strictEqual(joined.includes("gpt-5.3"), true);
	});

	it("treats zero-USD entries as `(local)` so free local runs read clearly", () => {
		const lines = formatCostOverlayLines(
			0,
			500,
			[{ providerId: "ollama", modelId: "llama3.1", runs: 1, tokens: 500, usd: 0 }],
			{ sessionId: null },
		);
		strictEqual(lines.join("\n").includes("(local)"), true);
	});
});
