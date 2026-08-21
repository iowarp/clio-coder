import type { SessionEntry } from "../../../session/entries.js";
import type { EvictionCandidate, PolicyInput, WorkingSetPolicy, WorkingSetPolicyId } from "../contract.js";
import { tokensFreedByEviction } from "../engine.js";
import { protectionCutoffIndex } from "../horizon.js";
import { buildPathIndex } from "../path-index.js";
import { isProtected } from "../protect.js";
import type { ReferenceGraph } from "./reference-graph.js";
import { countReplayTurns } from "./trace.js";

/** Replay-only diagnostic surface; it does not widen the live policy contract. */
export interface ReplayCandidatePoolPolicy extends WorkingSetPolicy {
	/** Number of currently usable candidates before target-based truncation. */
	replayCandidateCount(input: PolicyInput): number;
}

function controlId(id: string): WorkingSetPolicyId {
	return id as WorkingSetPolicyId;
}

function eligibleToolResults(input: PolicyInput): SessionEntry[] {
	const cutoff = protectionCutoffIndex(input.entries, input.settings.protectLastTurns);
	const index = buildPathIndex(input.entries, { cwd: input.cwd });
	const out: SessionEntry[] = [];
	for (let entryIndex = cutoff - 1; entryIndex >= 0; entryIndex -= 1) {
		const entry = input.entries[entryIndex];
		if (entry?.kind !== "message" || entry.role !== "tool_result") continue;
		if (input.view.evicted.has(entry.turnId)) continue;
		if (isProtected(entry, { entryIndex, cutoffIndex: cutoff, input, index })) continue;
		out.push(entry);
	}
	return out;
}

function takeToTarget(input: PolicyInput, entries: ReadonlyArray<SessionEntry>): EvictionCandidate[] {
	let tokensNeeded = Math.max(0, input.pressure.tokens - input.pressure.target * input.pressure.contextWindow);
	if (tokensNeeded <= 0) return [];
	const selected: EvictionCandidate[] = [];
	for (const entry of entries) {
		const candidate: EvictionCandidate = { ref: { entry: entry.turnId }, reason: "age_horizon" };
		selected.push(candidate);
		tokensNeeded -= tokensFreedByEviction(input.estimateTokens, entry, candidate);
		if (tokensNeeded <= 0) break;
	}
	return selected;
}

export function makeOraclePolicy(graph: ReferenceGraph): ReplayCandidatePoolPolicy {
	let lastInput: PolicyInput | null = null;
	let lastCandidateCount = 0;
	const safeEntries = (input: PolicyInput): SessionEntry[] => {
		const currentTurn = countReplayTurns(input.entries) + 1;
		return eligibleToolResults(input).filter((entry) => {
			const futureTurns = graph.futureTurnsOf.get(entry.turnId) ?? [];
			return futureTurns.every((turn) => turn < currentTurn);
		});
	};
	return {
		id: controlId("oracle"),
		select(input): ReadonlyArray<EvictionCandidate> {
			// Replay calls before the next turn-start entry is appended. A reference
			// in that next turn is therefore still future from the model's view.
			const safe = safeEntries(input);
			lastInput = input;
			lastCandidateCount = safe.length;
			return takeToTarget(input, safe);
		},
		replayCandidateCount(input): number {
			return input === lastInput ? lastCandidateCount : safeEntries(input).length;
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

export function makeRandomPolicy(seed: number): ReplayCandidatePoolPolicy {
	let lastInput: PolicyInput | null = null;
	let lastCandidateCount = 0;
	return {
		id: controlId("random"),
		select(input): ReadonlyArray<EvictionCandidate> {
			const entries = [...eligibleToolResults(input)];
			lastInput = input;
			lastCandidateCount = entries.length;
			const random = mulberry32(seed);
			for (let index = entries.length - 1; index > 0; index -= 1) {
				const swap = Math.floor(random() * (index + 1));
				const value = entries[index];
				entries[index] = entries[swap] as SessionEntry;
				entries[swap] = value as SessionEntry;
			}
			return takeToTarget(input, entries);
		},
		replayCandidateCount(input): number {
			return input === lastInput ? lastCandidateCount : eligibleToolResults(input).length;
		},
	};
}

export const nonePolicy: WorkingSetPolicy = {
	id: controlId("none"),
	select: () => [],
};
