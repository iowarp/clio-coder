/**
 * Tier-2 telemetry coverage: pin the per-tool aggregation invariants that the
 * dispatch parent uses to fold a worker's `clio_tool_finish` event stream into
 * a RunReceipt. Loops, retries-by-model, mixed outcomes, parallel-batch
 * concurrent calls, and admission-denial blocks all converge through these
 * helpers.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { countToolCalls, recordToolFinish, snapshotToolStats } from "../../src/domains/dispatch/tool-stats.js";
import type { ToolCallStat } from "../../src/domains/dispatch/types.js";

function makeMap(): Map<string, ToolCallStat> {
	return new Map<string, ToolCallStat>();
}

describe("dispatch/tool-stats recordToolFinish", () => {
	it("ignores payloads without a tool name", () => {
		const stats = makeMap();
		recordToolFinish(stats, { durationMs: 5, outcome: "ok" });
		recordToolFinish(stats, { tool: 42 as unknown as string, durationMs: 5, outcome: "ok" });
		strictEqual(stats.size, 0);
		strictEqual(countToolCalls(stats), 0);
	});

	it("aggregates a sequential loop of the same tool", () => {
		const stats = makeMap();
		for (let i = 0; i < 5; i++) {
			recordToolFinish(stats, { tool: "task_list", durationMs: 12, outcome: "ok" });
		}
		const stat = stats.get("task_list");
		ok(stat);
		strictEqual(stat.count, 5);
		strictEqual(stat.ok, 5);
		strictEqual(stat.errors, 0);
		strictEqual(stat.blocked, 0);
		strictEqual(stat.totalDurationMs, 60);
	});

	it("splits mixed outcomes across ok/errors/blocked while keeping count consistent", () => {
		const stats = makeMap();
		const ordered: Array<ToolCallStat["count"] extends number ? "ok" | "error" | "blocked" : never> = [
			"ok",
			"error",
			"ok",
			"blocked",
			"error",
			"ok",
		];
		for (const outcome of ordered) {
			recordToolFinish(stats, { tool: "bash", durationMs: 7, outcome });
		}
		const stat = stats.get("bash");
		ok(stat);
		strictEqual(stat.count, 6);
		strictEqual(stat.ok, 3);
		strictEqual(stat.errors, 2);
		strictEqual(stat.blocked, 1);
		strictEqual(stat.count, stat.ok + stat.errors + stat.blocked);
		strictEqual(stat.totalDurationMs, 42);
	});

	it("treats unknown outcomes as count-only (no bucket increment) so unexpected outcomes don't double-count", () => {
		const stats = makeMap();
		recordToolFinish(stats, { tool: "weird", durationMs: 3, outcome: "ok" });
		// Future-proofing: an outcome string the dispatcher hasn't learned yet
		// must still bump count so the receipt records that the call happened,
		// but must not silently fall through into ok/error/blocked.
		recordToolFinish(stats, { tool: "weird", durationMs: 4, outcome: "mystery" as never });
		const stat = stats.get("weird");
		ok(stat);
		strictEqual(stat.count, 2);
		strictEqual(stat.ok, 1);
		strictEqual(stat.errors, 0);
		strictEqual(stat.blocked, 0);
		strictEqual(stat.totalDurationMs, 7);
	});

	it("only accumulates finite non-negative durations into totalDurationMs", () => {
		const stats = makeMap();
		recordToolFinish(stats, { tool: "file_read", durationMs: 10, outcome: "ok" });
		recordToolFinish(stats, { tool: "file_read", durationMs: Number.NaN, outcome: "ok" });
		recordToolFinish(stats, { tool: "file_read", durationMs: Number.POSITIVE_INFINITY, outcome: "ok" });
		recordToolFinish(stats, { tool: "file_read", durationMs: -5, outcome: "ok" });
		recordToolFinish(stats, { tool: "file_read", outcome: "ok" });
		const stat = stats.get("file_read");
		ok(stat);
		strictEqual(stat.count, 5);
		strictEqual(stat.ok, 5);
		strictEqual(stat.totalDurationMs, 10);
	});

	it("aggregates parallel-batch tool calls (interleaved finishes for distinct tools) into separate entries", () => {
		const stats = makeMap();
		// Simulates pi-agent-core executing three tools in one assistant
		// turn whose finish events arrive interleaved over the IPC stream.
		recordToolFinish(stats, { tool: "file_read", durationMs: 8, outcome: "ok" });
		recordToolFinish(stats, { tool: "task_list", durationMs: 11, outcome: "ok" });
		recordToolFinish(stats, { tool: "search", durationMs: 5, outcome: "error" });
		recordToolFinish(stats, { tool: "file_read", durationMs: 4, outcome: "ok" });
		recordToolFinish(stats, { tool: "task_list", durationMs: 7, outcome: "ok" });
		strictEqual(stats.size, 3);
		strictEqual(stats.get("file_read")?.count, 2);
		strictEqual(stats.get("task_list")?.count, 2);
		strictEqual(stats.get("search")?.count, 1);
		strictEqual(stats.get("search")?.errors, 1);
	});

	it("preserves the same Map entry reference across writes (in-place mutation, no allocation per call)", () => {
		const stats = makeMap();
		recordToolFinish(stats, { tool: "bash", durationMs: 1, outcome: "ok" });
		const first = stats.get("bash");
		recordToolFinish(stats, { tool: "bash", durationMs: 2, outcome: "ok" });
		const second = stats.get("bash");
		strictEqual(first, second);
		strictEqual(second?.count, 2);
	});
});

describe("dispatch/tool-stats snapshotToolStats", () => {
	it("returns an array sorted by tool name ascending so receipt digests stay deterministic", () => {
		const stats = makeMap();
		recordToolFinish(stats, { tool: "task_list", outcome: "ok" });
		recordToolFinish(stats, { tool: "bash", outcome: "ok" });
		recordToolFinish(stats, { tool: "file_read", outcome: "ok" });
		const snapshot = snapshotToolStats(stats);
		deepStrictEqual(
			snapshot.map((s) => s.tool),
			["bash", "file_read", "task_list"],
		);
	});

	it("returns an empty array for an empty map", () => {
		deepStrictEqual(snapshotToolStats(makeMap()), []);
	});
});

describe("dispatch/tool-stats countToolCalls", () => {
	it("returns the sum of count across every entry", () => {
		const stats = makeMap();
		recordToolFinish(stats, { tool: "a", outcome: "ok" });
		recordToolFinish(stats, { tool: "a", outcome: "error" });
		recordToolFinish(stats, { tool: "b", outcome: "blocked" });
		recordToolFinish(stats, { tool: "c", outcome: "ok" });
		strictEqual(countToolCalls(stats), 4);
	});

	it("returns 0 for an empty map", () => {
		strictEqual(countToolCalls(makeMap()), 0);
	});
});
