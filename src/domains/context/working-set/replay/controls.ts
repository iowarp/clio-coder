import type { SessionEntry } from "../../../session/entries.js";
import type { EvictionCandidate, PolicyInput, WorkingSetPolicy, WorkingSetPolicyId } from "../contract.js";
import { hasLegacyCompactionMarker } from "../payload.js";
import type { ReferenceGraph } from "./reference-graph.js";
import { countReplayTurns, isReplayTurnStart } from "./trace.js";

function controlId(id: string): WorkingSetPolicyId {
	return id as WorkingSetPolicyId;
}

function recentTurnCutoff(entries: ReadonlyArray<SessionEntry>, protectLastTurns: number): number {
	const horizon = Math.max(1, Math.floor(protectLastTurns));
	let seen = 0;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined || !isReplayTurnStart(entry)) continue;
		seen += 1;
		if (seen >= horizon) return index;
	}
	return 0;
}

function eligibleToolResults(input: PolicyInput): SessionEntry[] {
	const cutoff = recentTurnCutoff(input.entries, input.settings.protectLastTurns);
	const out: SessionEntry[] = [];
	for (let index = cutoff - 1; index >= 0; index -= 1) {
		const entry = input.entries[index];
		if (entry?.kind !== "message" || entry.role !== "tool_result") continue;
		if (input.view.evicted.has(entry.turnId)) continue;
		if (hasLegacyCompactionMarker(entry.payload)) continue;
		if (input.estimateTokens(entry) < input.settings.minEvictableTokens) continue;
		out.push(entry);
	}
	return out;
}

function takeToTarget(input: PolicyInput, entries: ReadonlyArray<SessionEntry>): EvictionCandidate[] {
	let tokensNeeded = Math.max(0, input.pressure.tokens - input.pressure.target * input.pressure.contextWindow);
	if (tokensNeeded <= 0) return [];
	const selected: EvictionCandidate[] = [];
	for (const entry of entries) {
		selected.push({ ref: { entry: entry.turnId }, reason: "age_horizon" });
		tokensNeeded -= input.estimateTokens(entry);
		if (tokensNeeded <= 0) break;
	}
	return selected;
}

export function makeOraclePolicy(graph: ReferenceGraph): WorkingSetPolicy {
	return {
		id: controlId("oracle"),
		select(input): ReadonlyArray<EvictionCandidate> {
			// Replay calls before the next turn-start entry is appended. A reference
			// in that next turn is therefore still future from the model's view.
			const currentTurn = countReplayTurns(input.entries) + 1;
			const safe = eligibleToolResults(input).filter((entry) => {
				const futureTurns = graph.futureTurnsOf.get(entry.turnId) ?? [];
				return futureTurns.every((turn) => turn < currentTurn);
			});
			return takeToTarget(input, safe);
		},
	};
}

/** Graph-free export for callers that need a registry-shaped control. */
export const oraclePolicy: WorkingSetPolicy = makeOraclePolicy({ edges: [], futureTurnsOf: new Map() });

function mulberry32(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value = (value + 0x6d2b79f5) >>> 0;
		let next = value;
		next = Math.imul(next ^ (next >>> 15), next | 1);
		next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
		return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export function makeRandomPolicy(seed: number): WorkingSetPolicy {
	return {
		id: controlId("random"),
		select(input): ReadonlyArray<EvictionCandidate> {
			const entries = [...eligibleToolResults(input)];
			const random = mulberry32(seed);
			for (let index = entries.length - 1; index > 0; index -= 1) {
				const swap = Math.floor(random() * (index + 1));
				const value = entries[index];
				entries[index] = entries[swap] as SessionEntry;
				entries[swap] = value as SessionEntry;
			}
			return takeToTarget(input, entries);
		},
	};
}

export const nonePolicy: WorkingSetPolicy = {
	id: controlId("none"),
	select: () => [],
};
