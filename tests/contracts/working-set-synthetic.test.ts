/**
 * The procedural corpus is the replay's stress input. These contracts pin what
 * makes its numbers worth reading: every byte follows from the seed, the
 * ledger is well formed for the path index, every structural rung and every
 * reference-edge kind has material to act on, and the two cost metrics the
 * corpus was built to measure are computed from the events they describe.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { GUARDRAIL_DEFAULTS } from "../../src/core/guardrails.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { buildPathIndex } from "../../src/domains/context/working-set/path-index.js";
import { resolveWorkingSetPolicy } from "../../src/domains/context/working-set/policies/index.js";
import { nonePolicy } from "../../src/domains/context/working-set/replay/controls.js";
import { measureReplayTrace } from "../../src/domains/context/working-set/replay/metrics.js";
import { buildReferenceGraph } from "../../src/domains/context/working-set/replay/reference-graph.js";
import { type ReplayConfig, replayTrace } from "../../src/domains/context/working-set/replay/runner.js";
import {
	generateSyntheticCorpora,
	generateSyntheticTrace,
	SYNTHETIC_CORPORA,
	syntheticCorpus,
} from "../../src/domains/context/working-set/replay/synthetic.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";

const OBSERVATION_TOOLS = new Set(["read", "grep", "find", "ls"]);

function toolResultText(entry: { payload: unknown }): string {
	const payload = entry.payload as Record<string, unknown>;
	const result = payload.result as Record<string, unknown> | undefined;
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const value = block as Record<string, unknown>;
			return typeof value.text === "string" ? value.text : "";
		})
		.join("\n");
}

function config(policyId: string, budgetTokens: number): ReplayConfig {
	return { policyId, budgetTokens, threshold: 0.8, target: 0.6, settings: DEFAULT_WORKING_SET_SETTINGS, seed: 0 };
}

describe("contracts/working-set synthetic corpus", () => {
	it("is a pure function of the spec and index", () => {
		for (const spec of SYNTHETIC_CORPORA) {
			const first = generateSyntheticTrace(spec, 0);
			const second = generateSyntheticTrace(spec, 0);
			assert.equal(JSON.stringify(second.entries), JSON.stringify(first.entries), spec.id);
			assert.equal(first.turnCount, spec.turns);
			assert.notEqual(JSON.stringify(generateSyntheticTrace(spec, 1).entries), JSON.stringify(first.entries));
		}
	});

	it("pairs every tool result with its call and chains the ledger linearly", () => {
		const spec = syntheticCorpus("science-long");
		assert.ok(spec);
		const trace = generateSyntheticTrace({ ...spec, turns: 40 }, 3);
		const calls = new Set<string>();
		let previous: string | null = null;
		for (const entry of trace.entries) {
			assert.equal(entry.parentTurnId, previous);
			previous = entry.turnId;
			if (entry.kind !== "message") continue;
			const payload = entry.payload as { toolCallId?: string };
			if (entry.role === "tool_call") calls.add(payload.toolCallId as string);
			if (entry.role === "tool_result") assert.ok(calls.has(payload.toolCallId as string));
		}
	});

	it("keeps every episode within the shipped call and observation ceilings", () => {
		for (const spec of SYNTHETIC_CORPORA) {
			for (let traceIndex = 0; traceIndex < spec.traces; traceIndex += 1) {
				const trace = generateSyntheticTrace(spec, traceIndex);
				let calls = 0;
				let observationBytes = 0;
				const assertTurn = () => {
					assert.ok(calls <= GUARDRAIL_DEFAULTS.turnToolCallBudget, `${trace.id}: ${calls} calls`);
					assert.ok(
						observationBytes <= GUARDRAIL_DEFAULTS.observationTurnBudgetBytes,
						`${trace.id}: ${observationBytes} observation bytes`,
					);
				};
				for (const entry of trace.entries) {
					if (entry.kind !== "message") continue;
					if (entry.role === "user") {
						assertTurn();
						calls = 0;
						observationBytes = 0;
					} else if (entry.role === "tool_call") {
						calls += 1;
					} else if (entry.role === "tool_result") {
						const payload = entry.payload as Record<string, unknown>;
						if (typeof payload.toolName === "string" && OBSERVATION_TOOLS.has(payload.toolName)) {
							observationBytes += Buffer.byteLength(toolResultText(entry), "utf8");
						}
					}
				}
				assertTurn();
			}
		}
	});

	it("exercises every structural rung and every reference-edge kind", () => {
		const spec = syntheticCorpus("science-long");
		assert.ok(spec);
		const trace = generateSyntheticTrace(spec, 0);
		const index = buildPathIndex(trace.entries, { cwd: trace.cwd });
		const graph = buildReferenceGraph(trace, index);
		assert.deepEqual([...new Set(graph.edges.map((edge) => edge.kind))].sort(), [
			"file_discovery",
			"file_reread",
			"file_rewrite",
		]);
		const replay = replayTrace(trace, resolveWorkingSetPolicy("structural-v1"), config("structural-v1", 64_000));
		const reasons = new Set(replay.events.flatMap((event) => event.items.map((item) => item.reason)));
		assert.deepEqual([...reasons].sort(), [
			"age_horizon",
			"failure_resolved",
			"listing_consumed",
			"stale_after_mutation",
			"superseded_read",
			"thinking_turn_closed",
		]);
		assert.ok(
			replay.events.some((event) => event.items.some((item) => item.marker.includes(" offload="))),
			"an offloaded simulation result must be evicted with its pointer",
		);
	});

	it("runs longer between summary compactions than no eviction under the modeled summary stage", () => {
		const spec = syntheticCorpus("science-long");
		assert.ok(spec);
		const trace = generateSyntheticTrace(spec, 0);
		const summaries = { keepRecentTokens: 20_000, summaryTokens: 1_500 };
		const withoutEviction = replayTrace(trace, nonePolicy, { ...config("none", 64_000), summaries });
		const structural = replayTrace(trace, resolveWorkingSetPolicy("structural-v1"), {
			...config("structural-v1", 64_000),
			summaries,
		});
		assert.ok(withoutEviction.summaries > 0);
		assert.ok(
			structural.summaries * 2 < withoutEviction.summaries,
			`${structural.summaries} vs ${withoutEviction.summaries}`,
		);
		assert.equal(
			withoutEviction.entries.filter((entry) => entry.kind === "compactionSummary").length,
			withoutEviction.summaries,
		);
		// Without the model, the runner only records where the first summary would have run.
		assert.equal(replayTrace(trace, nonePolicy, config("none", 64_000)).summaries, 0);
	});

	it("prices the cold prefix and the recall bill from the events that cause them", () => {
		const spec = syntheticCorpus("refactor");
		assert.ok(spec);
		const trace = generateSyntheticTrace({ ...spec, turns: 60 }, 0);
		const index = buildPathIndex(trace.entries, { cwd: trace.cwd });
		const graph = buildReferenceGraph(trace, index);
		const none = measureReplayTrace({
			trace,
			index,
			graph,
			replay: replayTrace(trace, nonePolicy, config("none", 32_000)),
		});
		assert.equal(none.coldPrefixTokens, 0);
		assert.equal(none.recallTokens, 0);

		const replay = replayTrace(trace, resolveWorkingSetPolicy("structural-v1"), config("structural-v1", 32_000));
		assert.ok(replay.events.length > 0);
		for (const event of replay.events) {
			// The cold region is a suffix of the post-event projection. Usage
			// invalidation stamps are metadata, so they cannot make it cost more
			// than the planner's tokensAfter projection.
			assert.ok(event.coldPrefixTokens > 0 && event.coldPrefixTokens <= event.tokensAfter);
		}
		const metrics = measureReplayTrace({ trace, index, graph, replay });
		assert.equal(
			metrics.coldPrefixTokens,
			replay.events.reduce((sum, event) => sum + event.coldPrefixTokens, 0),
		);
		assert.ok(metrics.recallTokens <= metrics.tokensEvicted);
		// Precision is the item-count view of the same split the recall bill is the token view of.
		const referencedItems = replay.events.flatMap((event) =>
			event.items.filter((item) => (graph.futureTurnsOf.get(item.ref.entry) ?? []).some((turn) => turn > event.turnIndex)),
		);
		assert.equal(
			metrics.recallTokens,
			referencedItems.reduce((sum, item) => sum + item.tokensFreed, 0),
		);
	});

	it("reports the corpus through the loader's cascade shape", () => {
		const { traces, cascade } = generateSyntheticCorpora(["exploration"]);
		const spec = syntheticCorpus("exploration");
		assert.ok(spec);
		assert.equal(traces.length, spec.traces);
		assert.deepEqual(cascade, { found: spec.traces, unreadable: 0, filtered: {}, kept: spec.traces });
		assert.ok(traces.every((trace) => trace.entries.reduce((sum, entry) => sum + estimateTokens(entry), 0) > 128_000));
		assert.throws(() => generateSyntheticCorpora(["nope"]), /unknown synthetic corpus: nope/);
	});
});
