import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
	PolicyInput,
	WorkingSetPolicy,
	WorkingSetSettings,
} from "../../src/domains/context/working-set/contract.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { planEviction } from "../../src/domains/context/working-set/engine.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { isTurnStart } from "../../src/domains/context/working-set/horizon.js";
import {
	buildPathIndex,
	type PathIndex,
	type PathObservation,
} from "../../src/domains/context/working-set/path-index.js";
import { resolveWorkingSetPolicy } from "../../src/domains/context/working-set/policies/index.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import {
	makeOraclePolicy,
	makeRandomPolicy,
	nonePolicy,
} from "../../src/domains/context/working-set/replay/controls.js";
import { loadClioTraces } from "../../src/domains/context/working-set/replay/load-clio.js";
import { aggregateReplayMetrics, measureReplayTrace } from "../../src/domains/context/working-set/replay/metrics.js";
import {
	buildReferenceGraph,
	type ReferenceGraph,
} from "../../src/domains/context/working-set/replay/reference-graph.js";
import {
	type ReplayPolicyResult,
	renderReplayJson,
	renderReplayMarkdown,
} from "../../src/domains/context/working-set/replay/report.js";
import {
	type ReplayConfig,
	type ReplayTraceResult,
	replayTrace,
} from "../../src/domains/context/working-set/replay/runner.js";
import type { Trace } from "../../src/domains/context/working-set/replay/trace.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/context-replay/fixture-01.jsonl", import.meta.url));
const SETTINGS: WorkingSetSettings = {
	...DEFAULT_WORKING_SET_SETTINGS,
	protectLastTurns: 3,
	minEvictableTokens: 0,
};

async function fixture(): Promise<{ trace: Trace; graph: ReferenceGraph }> {
	const loaded = await loadClioTraces([FIXTURE]);
	assert.deepEqual(loaded.cascade, {
		found: 1,
		unreadable: 0,
		filtered: { turns_lt_8: 0, tool_results_lt_8: 0, no_file_reread: 0 },
		kept: 1,
	});
	const trace = loaded.traces[0];
	assert.ok(trace);
	return { trace, graph: buildReferenceGraph(trace, buildPathIndex(trace.entries)) };
}

function config(policyId: string, budgetTokens = 12_000, settings = SETTINGS): ReplayConfig {
	return { policyId, budgetTokens, threshold: 0.8, target: 0.6, settings, seed: 0 };
}

function prefixBeforeTurn(trace: Trace, wantedTurn: number): SessionEntry[] {
	const prefix: SessionEntry[] = [];
	let turn = 0;
	for (const entry of trace.entries) {
		if (isTurnStart(entry)) {
			turn += 1;
			if (turn === wantedTurn) return prefix;
		}
		prefix.push(entry);
	}
	throw new Error(`fixture has no turn ${wantedTurn}`);
}

function lastMessage(entries: ReadonlyArray<SessionEntry>): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.kind === "message") return entry.turnId;
	}
	return undefined;
}

function projectedTokens(entries: ReadonlyArray<SessionEntry>, leaf?: string): number {
	const view = foldWorkingSet(entries, leaf);
	return projectWorkingSet(entries, view).reduce((sum, entry) => sum + estimateTokens(entry), 0);
}

function refSet(items: ReadonlyArray<{ ref: { entry: string } }>): Set<string> {
	return new Set(items.map((item) => item.ref.entry));
}

describe("contracts/working-set replay-lite", () => {
	it("drives age-horizon through the identical live planner at the same prefix", async () => {
		const { trace } = await fixture();
		const policy = resolveWorkingSetPolicy("age-horizon");
		const replay = replayTrace(trace, policy, config("age-horizon"));
		assert.equal(replay.events.length, 1, "fixture budget should isolate one append-only eviction event");
		const event = replay.events[0];
		assert.ok(event);
		assert.equal(event.saturated, true, "age-horizon drains every eligible candidate");

		const prefix = prefixBeforeTurn(trace, event.turnIndex);
		const leaf = lastMessage(prefix);
		const tokens = projectedTokens(prefix, leaf);
		const input: PolicyInput = {
			entries: prefix,
			view: foldWorkingSet(prefix, leaf),
			cwd: trace.cwd,
			settings: SETTINGS,
			pressure: { tokens, contextWindow: 12_000, threshold: 0.8, target: 0.6 },
			estimateTokens,
		};
		const direct = planEviction(policy, input);
		assert.ok(direct);
		assert.deepEqual(refSet(event.items), refSet(direct.items));

		const synthetic = replay.entries.filter((entry) => entry.kind === "contextEviction");
		assert.equal(synthetic.length, 1);
		assert.deepEqual(refSet(synthetic[0]?.evicted ?? []), refSet(direct.items));
		assert.equal(synthetic[0]?.parentTurnId, leaf);
		assert.equal(synthetic[0]?.timestamp, prefix[prefix.length - 1]?.timestamp);
	});

	it("labels the fixture's reread, discovery, and rewrite edges exactly", async () => {
		const { graph } = await fixture();
		assert.deepEqual(graph.edges, [
			{ from: "result-01", toTurnIndex: 5, kind: "file_reread" },
			{ from: "result-02", toTurnIndex: 6, kind: "file_rewrite" },
			{ from: "result-03", toTurnIndex: 4, kind: "file_discovery" },
			{ from: "result-03", toTurnIndex: 10, kind: "file_discovery" },
			{ from: "result-09", toTurnIndex: 12, kind: "file_rewrite" },
		]);
		assert.deepEqual(
			[...graph.futureTurnsOf],
			[
				["result-01", [5]],
				["result-03", [4, 10]],
			],
		);
	});

	it("counts a ref evicted two turns before reuse as lost retention and full churn", async () => {
		const { trace } = await fixture();
		const index = buildPathIndex(trace.entries);
		const replay: ReplayTraceResult = {
			traceId: trace.id,
			policyId: "hand-computed",
			budgetTokens: 1_000,
			turnCount: trace.turnCount,
			events: [
				{
					turnIndex: 1,
					items: [
						{
							ref: { entry: "result-01" },
							reason: "age_horizon",
							tokensFreed: 250,
							marker: "[evicted ref=result-01]",
						},
					],
					tokensBefore: 900,
					tokensAfter: 650,
					saturated: true,
					coldPrefixTokens: 0,
				},
			],
			evictedAtTurn: new Map([["result-01", 1]]),
			turnsToFirstSummary: null,
			summaries: 0,
			entries: trace.entries,
		};
		const graph: ReferenceGraph = {
			edges: [{ from: "result-01", toTurnIndex: 3, kind: "file_reread" }],
			futureTurnsOf: new Map([["result-01", [3]]]),
		};
		const metrics = measureReplayTrace({ trace, index, graph, replay });
		assert.equal(metrics.retention, 0);
		assert.equal(metrics.retentionCovered, 0);
		assert.equal(metrics.retentionAt10, 0);
		assert.equal(metrics.evictionPrecision, 0);
		assert.equal(metrics.tokensEvicted, 250);
		assert.equal(metrics.evictionEvents, 1);
		assert.equal(metrics.saturatedEvents, 1);
	});

	it("credits only a newer covering read that survives until the future reference", async () => {
		const { trace } = await fixture();
		const original: PathObservation = {
			ref: { entry: "original" },
			toolCallId: "call-original",
			toolName: "read",
			op: "read",
			path: "/repo/src/a.ts",
			range: { offset: 20, limit: 10 },
			surfaced: [],
			isError: false,
			isBlocked: false,
			turnIndex: 0,
			entryIndex: 0,
			argsKey: "",
		};
		const newer: PathObservation = {
			...original,
			ref: { entry: "newer" },
			toolCallId: "call-newer",
			range: { offset: 10, limit: 40 },
			turnIndex: 2,
			entryIndex: 1,
		};
		const index: PathIndex = {
			observations: [original, newer],
			byRef: new Map([
				["original", original],
				["newer", newer],
			]),
			byPath: new Map([[original.path, [original, newer]]]),
			turnIndexOf: new Map(),
			turnCount: 5,
		};
		const graph: ReferenceGraph = {
			edges: [{ from: "original", toTurnIndex: 4, kind: "file_reread" }],
			futureTurnsOf: new Map([["original", [4]]]),
		};
		const replay: ReplayTraceResult = {
			traceId: trace.id,
			policyId: "hand-computed",
			budgetTokens: 1_000,
			turnCount: 5,
			events: [],
			evictedAtTurn: new Map([["original", 1]]),
			turnsToFirstSummary: null,
			summaries: 0,
			entries: trace.entries,
		};

		const covered = measureReplayTrace({ trace, index, graph, replay });
		assert.equal(covered.retention, 0);
		assert.equal(covered.retentionCovered, 1);
		const aggregate = aggregateReplayMetrics([{ trace, index, graph, replay }]);
		assert.equal(aggregate.pooledRetention, 0);
		assert.equal(aggregate.pooledRetentionCovered, 1);

		const newerAlsoEvicted = measureReplayTrace({
			trace,
			index,
			graph,
			replay: {
				...replay,
				evictedAtTurn: new Map([
					["original", 1],
					["newer", 3],
				]),
			},
		});
		assert.equal(newerAlsoEvicted.retentionCovered, 0);
	});

	it("pools saturated events by event count rather than by trace", async () => {
		const { trace, graph } = await fixture();
		const index = buildPathIndex(trace.entries);
		const base = replayTrace(trace, nonePolicy, config("none"));
		const event = (saturated: boolean) => ({
			turnIndex: 1,
			items: [],
			tokensBefore: 900,
			tokensAfter: 900,
			saturated,
			coldPrefixTokens: 0,
		});
		const aggregate = aggregateReplayMetrics([
			{ trace, index, graph, replay: { ...base, events: [event(true), event(false)] } },
			{ trace, index, graph, replay: { ...base, events: [event(true)] } },
			{ trace, index, graph, replay: base },
		]);
		assert.equal(aggregate.mean.saturatedEvents, 2 / 3);
	});

	it("oracle never evicts a critical ref before its final reference", async () => {
		const { trace, graph } = await fixture();
		const replay = replayTrace(
			trace,
			makeOraclePolicy(graph),
			config("oracle", 7_000, { ...SETTINGS, protectLastTurns: 2 }),
		);
		let checkedCritical = 0;
		for (const event of replay.events) {
			for (const item of event.items) {
				const future = graph.futureTurnsOf.get(item.ref.entry);
				if (future === undefined) continue;
				checkedCritical += 1;
				assert.equal(
					future.every((turn) => turn < event.turnIndex),
					true,
					`${item.ref.entry} was evicted at ${event.turnIndex} before ${future.join(",")}`,
				);
			}
		}
		assert.ok(checkedCritical > 0, "fixture must exercise an eventually-safe critical ref");
	});

	it("random produces the identical event sequence for one seed", async () => {
		const { trace } = await fixture();
		const replayConfig = config("random", 7_000, { ...SETTINGS, protectLastTurns: 2 });
		const run = (): ReadonlyArray<ReadonlyArray<string>> =>
			replayTrace(trace, makeRandomPolicy(17), replayConfig).events.map((event) =>
				event.items.map((item) => item.ref.entry),
			);
		assert.deepEqual(run(), run());
	});

	it("renders one policy row per budget and stable provenance JSON", async () => {
		const { trace, graph } = await fixture();
		const index = buildPathIndex(trace.entries);
		const policies: ReadonlyArray<readonly [string, WorkingSetPolicy]> = [
			["none", nonePolicy],
			["age-horizon", resolveWorkingSetPolicy("age-horizon")],
			["structural-v1", resolveWorkingSetPolicy("structural-v1")],
		];
		const budgets = [12_000, 16_000];
		const results: ReplayPolicyResult[] = [];
		for (const budget of budgets) {
			for (const [policyId, policy] of policies) {
				const replay = replayTrace(trace, policy, config(policyId, budget));
				results.push({
					budgetTokens: budget,
					policyId,
					metrics: aggregateReplayMetrics([{ trace, index, graph, replay }]),
				});
			}
		}
		const input = {
			config: {
				policies: policies.map(([id]) => id),
				budgets,
				threshold: 0.8,
				target: 0.6,
				seed: 0,
				corpus: ["ledgers"],
				filter: "default" as const,
				settings: SETTINGS,
			},
			cascade: {
				found: 1,
				unreadable: 0,
				filtered: { turns_lt_8: 0, tool_results_lt_8: 0, no_file_reread: 0 },
				kept: 1,
			},
			results,
			gitSha: "abc123",
			commandLine: ["node", "src/cli/index.ts", "context", "replay"],
		};
		const markdown = renderReplayMarkdown(input);
		for (const [policyId] of policies) {
			assert.equal(markdown.match(new RegExp(`^\\| ${policyId} \\|`, "gm"))?.length, budgets.length);
		}
		assert.equal(markdown.match(/^## Budget /gm)?.length, budgets.length);
		assert.equal(markdown.match(/\(n=\d+\)/g)?.length, policies.length * budgets.length);
		assert.match(markdown, /\| saturated events \|/);
		assert.match(markdown, /\| retention covered \(mean\) \| retention covered \(pooled\) \|/);

		const json = renderReplayJson(input);
		assert.equal(renderReplayJson(input), json, "stable input must render byte-identically");
		const parsed = JSON.parse(json) as {
			provenance: { gitSha: string; commandLine: string[] };
			results: Array<{
				metrics: {
					pooledRetentionCovered: number;
					mean: {
						retentionCovered: number;
						saturatedEvents: number;
						turnsToFirstSummary: number | null;
						turnsToFirstSummaryCount: number;
					};
				};
			}>;
		};
		assert.equal(parsed.provenance.gitSha, "abc123");
		assert.deepEqual(parsed.provenance.commandLine, input.commandLine);
		assert.equal(parsed.results.length, policies.length * budgets.length);
		for (const result of parsed.results) {
			assert.equal(typeof result.metrics.mean.retentionCovered, "number");
			assert.equal(typeof result.metrics.pooledRetentionCovered, "number");
			assert.equal(typeof result.metrics.mean.saturatedEvents, "number");
			assert.equal(result.metrics.mean.turnsToFirstSummaryCount, result.metrics.mean.turnsToFirstSummary === null ? 0 : 1);
		}
	});
});
