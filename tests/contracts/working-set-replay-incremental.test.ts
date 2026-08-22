import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { WorkingSetPolicy, WorkingSetSettings } from "../../src/domains/context/working-set/contract.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { buildEvictionFields, planEviction } from "../../src/domains/context/working-set/engine.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { isTurnStart } from "../../src/domains/context/working-set/horizon.js";
import { resolveWorkingSetPolicy } from "../../src/domains/context/working-set/policies/index.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import { loadClioTraces } from "../../src/domains/context/working-set/replay/load-clio.js";
import {
	type ReplayConfig,
	type ReplayEvictionEvent,
	type ReplayTraceResult,
	replayTrace,
} from "../../src/domains/context/working-set/replay/runner.js";
import { generateSyntheticTrace, syntheticCorpus } from "../../src/domains/context/working-set/replay/synthetic.js";
import type { Trace } from "../../src/domains/context/working-set/replay/trace.js";
import { selectVisibleEntries } from "../../src/domains/context/working-set/visible.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { ContextEvictionEntry, SessionEntry } from "../../src/domains/session/entries.js";

const CLIO_FIXTURE = fileURLToPath(new URL("../fixtures/context-replay/fixture-01.jsonl", import.meta.url));
const SETTINGS: WorkingSetSettings = {
	...DEFAULT_WORKING_SET_SETTINGS,
	protectLastTurns: 3,
	minEvictableTokens: 0,
};

interface ReferenceResult {
	events: ReadonlyArray<Omit<ReplayEvictionEvent, "saturated" | "coldPrefixTokens">>;
	evictedAtTurn: ReadonlyMap<string, number>;
	turnsToFirstSummary: number | null;
	entries: ReadonlyArray<SessionEntry>;
}

function projectedTokens(entries: ReadonlyArray<SessionEntry>, leaf: string | null): number {
	const view = foldWorkingSet(entries, leaf ?? undefined);
	return projectWorkingSet(selectVisibleEntries(entries, leaf ?? undefined), view).reduce(
		(sum, entry) => sum + estimateTokens(entry),
		0,
	);
}

/** Frozen copy of the quadratic runner, retained only as an equivalence oracle. */
function referenceReplay(trace: Trace, policy: WorkingSetPolicy, config: ReplayConfig): ReferenceResult {
	const soFar: SessionEntry[] = [];
	const events: Array<Omit<ReplayEvictionEvent, "saturated" | "coldPrefixTokens">> = [];
	const evictedAtTurn = new Map<string, number>();
	const toolResults = new Set(
		trace.entries
			.filter((entry) => entry.kind === "message" && entry.role === "tool_result")
			.map((entry) => entry.turnId),
	);
	let sequence = 0;
	let turnIndex = 0;
	let turnsToFirstSummary: number | null = null;
	const pressureLimit = config.threshold * config.budgetTokens;
	for (const entry of trace.entries) {
		if (isTurnStart(entry)) {
			turnIndex += 1;
			const leaf = [...soFar].reverse().find((candidate) => candidate.kind === "message")?.turnId ?? null;
			const tokens = projectedTokens(soFar, leaf);
			if (tokens > pressureLimit) {
				const view = foldWorkingSet(soFar, leaf ?? undefined);
				const plan = planEviction(policy, {
					entries: selectVisibleEntries(soFar, leaf ?? undefined),
					view,
					cwd: trace.cwd,
					settings: config.settings,
					pressure: {
						tokens,
						contextWindow: config.budgetTokens,
						threshold: config.threshold,
						target: config.target,
					},
					estimateTokens,
				});
				if (plan !== null) {
					sequence += 1;
					const previous = soFar[soFar.length - 1];
					const synthetic: ContextEvictionEntry = {
						...buildEvictionFields(plan, {
							trigger: "pressure",
							pressureBefore: tokens / config.budgetTokens,
							snapshotIdBefore: null,
						}),
						turnId: `replay-evict-${sequence}`,
						parentTurnId: leaf,
						timestamp: previous?.timestamp ?? entry.timestamp,
					};
					soFar.push(synthetic);
					events.push({
						turnIndex,
						items: plan.items,
						tokensBefore: plan.tokensBefore,
						tokensAfter: plan.tokensAfter,
					});
					for (const item of plan.items) {
						if (toolResults.has(item.ref.entry) && !evictedAtTurn.has(item.ref.entry)) {
							evictedAtTurn.set(item.ref.entry, turnIndex);
						}
					}
				}
				if (turnsToFirstSummary === null && projectedTokens(soFar, leaf) > pressureLimit) {
					turnsToFirstSummary = turnIndex;
				}
			}
		}
		soFar.push(entry);
	}
	return { events, evictedAtTurn, turnsToFirstSummary, entries: soFar };
}

function comparable(result: ReplayTraceResult | ReferenceResult) {
	return {
		events: result.events.map(({ turnIndex, items, tokensBefore, tokensAfter }) => ({
			turnIndex,
			items,
			tokensBefore,
			tokensAfter,
		})),
		evictedAtTurn: [...result.evictedAtTurn],
		turnsToFirstSummary: result.turnsToFirstSummary,
		evictions: result.entries.filter((entry) => entry.kind === "contextEviction"),
	};
}

function replayConfig(policyId: string, budgetTokens: number): ReplayConfig {
	return { policyId, budgetTokens, threshold: 0.8, target: 0.6, settings: SETTINGS, seed: 0 };
}

function timestamp(index: number): string {
	return `2026-08-21T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
}

function syntheticTrace(turns: number): Trace {
	const entries: SessionEntry[] = [];
	let parentTurnId: string | null = null;
	let event = 0;
	const append = (entry: SessionEntry): void => {
		entries.push(entry);
		if (entry.kind === "message") parentTurnId = entry.turnId;
		event += 1;
	};
	for (let turn = 1; turn <= turns; turn += 1) {
		const userId = `synthetic-user-${turn}`;
		append({
			kind: "message",
			role: "user",
			payload: { text: `turn ${turn}` },
			turnId: userId,
			parentTurnId,
			timestamp: timestamp(event),
		});
		const assistantId = `synthetic-assistant-${turn}`;
		const thinking = turn % 5 === 0 ? `reasoning-${turn}-${"t".repeat(180)}` : "";
		append({
			kind: "message",
			role: "assistant",
			payload: {
				text: "reading",
				content: [...(thinking.length > 0 ? [{ type: "thinking", thinking }] : []), { type: "text", text: "reading" }],
				...(thinking.length > 0 ? { thinking } : {}),
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
			},
			turnId: assistantId,
			parentTurnId,
			timestamp: timestamp(event),
		});
		const callId = `synthetic-call-${turn}`;
		append({
			kind: "message",
			role: "tool_call",
			payload: { toolCallId: callId, name: "read", args: { path: `src/file-${turn % 25}.ts` } },
			turnId: `${callId}-entry`,
			parentTurnId,
			timestamp: timestamp(event),
		});
		append({
			kind: "message",
			role: "tool_result",
			payload: {
				toolCallId: callId,
				toolName: "read",
				result: { content: [{ type: "text", text: `src/file-${turn % 25}.ts\n${"x".repeat(360)}` }] },
				isError: false,
			},
			turnId: `synthetic-result-${turn}`,
			parentTurnId,
			timestamp: timestamp(event),
		});
		if (turn === 220) {
			entries.push({
				kind: "compactionSummary",
				summary: "synthetic compaction bridge",
				tokensBefore: 30_000,
				firstKeptTurnId: "synthetic-user-180",
				turnId: "synthetic-compaction-1",
				parentTurnId,
				timestamp: timestamp(event),
			});
			event += 1;
		}
	}
	return { id: `synthetic-${turns}`, source: "synthetic", cwd: "/fixture/synthetic", entries, turnCount: turns };
}

describe("contracts/working-set incremental replay", () => {
	it("is event-identical to the quadratic reference on the frozen fixture and a procedural trace", async () => {
		const clio = (await loadClioTraces([CLIO_FIXTURE])).traces[0];
		const spec = syntheticCorpus("science-long");
		assert.ok(clio);
		assert.ok(spec);
		const procedural = generateSyntheticTrace({ ...spec, turns: 30 }, 0);
		for (const [trace, budget] of [
			[clio, 12_000],
			[procedural, 24_000],
		] as const) {
			const config = replayConfig("age-horizon", budget);
			assert.deepEqual(
				comparable(replayTrace(trace, resolveWorkingSetPolicy("age-horizon"), config)),
				comparable(referenceReplay(trace, resolveWorkingSetPolicy("age-horizon"), config)),
			);
		}
	});

	it("is event-identical across 400 turns, repeated evictions, usage stamps, and a compaction cut", () => {
		const trace = syntheticTrace(400);
		const config = replayConfig("age-horizon", 8_000);
		const actual = replayTrace(trace, resolveWorkingSetPolicy("age-horizon"), config);
		const expected = referenceReplay(trace, resolveWorkingSetPolicy("age-horizon"), config);
		assert.ok(actual.events.length > 2, "synthetic trace must exercise repeated incremental events");
		assert.deepEqual(comparable(actual), comparable(expected));
	});
});
