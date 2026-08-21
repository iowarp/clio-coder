import type { WorkingSetSettings } from "../../../../core/defaults.js";
import { estimateTokens } from "../../../session/compaction/tokens.js";
import type { ContextEvictionEntry, EvictedItem, SessionEntry } from "../../../session/entries.js";
import type { WorkingSetPolicy } from "../contract.js";
import { buildEvictionFields, planEviction } from "../engine.js";
import { foldWorkingSet } from "../fold.js";
import { projectWorkingSet } from "../project.js";
import { isReplayTurnStart, type Trace } from "./trace.js";

export interface ReplayConfig {
	policyId: string;
	budgetTokens: number;
	threshold: number;
	target: number;
	settings: WorkingSetSettings;
	seed: number;
}

export interface ReplayEvictionEvent {
	turnIndex: number;
	items: ReadonlyArray<EvictedItem>;
	tokensBefore: number;
	tokensAfter: number;
}

export interface ReplayTraceResult {
	traceId: string;
	policyId: string;
	budgetTokens: number;
	turnCount: number;
	events: ReadonlyArray<ReplayEvictionEvent>;
	/** Tool-result refs only; thinking-unit evictions are intentionally absent. */
	evictedAtTurn: ReadonlyMap<string, number>;
	turnsToFirstSummary: number | null;
	/** Original entries plus synthetic append-only contextEviction sidecars. */
	entries: ReadonlyArray<SessionEntry>;
}

function sumProjectedTokens(entries: ReadonlyArray<SessionEntry>, activeLeafTurnId?: string): number {
	const view = foldWorkingSet(entries, activeLeafTurnId);
	let tokens = 0;
	for (const entry of projectWorkingSet(entries, view)) tokens += estimateTokens(entry);
	return tokens;
}

function lastMessageTurnId(entries: ReadonlyArray<SessionEntry>): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.kind === "message") return entry.turnId;
	}
	return null;
}

/** Live plan/fold/project code driven at deterministic ledger turn boundaries. */
export function replayTrace(trace: Trace, policy: WorkingSetPolicy, config: ReplayConfig): ReplayTraceResult {
	const soFar: SessionEntry[] = [];
	const events: ReplayEvictionEvent[] = [];
	const evictedAtTurn = new Map<string, number>();
	const toolResults = new Set(
		trace.entries
			.filter((entry) => entry.kind === "message" && entry.role === "tool_result")
			.map((entry) => entry.turnId),
	);
	let evictionSequence = 0;
	let turnIndex = 0;
	let turnsToFirstSummary: number | null = null;
	const pressureLimit = config.threshold * config.budgetTokens;

	for (const entry of trace.entries) {
		if (isReplayTurnStart(entry)) {
			turnIndex += 1;
			const leaf = lastMessageTurnId(soFar);
			const tokens = sumProjectedTokens(soFar, leaf ?? undefined);
			if (tokens > pressureLimit) {
				const view = foldWorkingSet(soFar, leaf ?? undefined);
				const plan = planEviction(policy, {
					entries: soFar,
					view,
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
					evictionSequence += 1;
					const previous = soFar[soFar.length - 1];
					const synthetic: ContextEvictionEntry = {
						...buildEvictionFields(plan, {
							trigger: "pressure",
							pressureBefore: tokens / config.budgetTokens,
							snapshotIdBefore: null,
						}),
						turnId: `replay-evict-${evictionSequence}`,
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
				const postTokens = sumProjectedTokens(soFar, leaf ?? undefined);
				if (turnsToFirstSummary === null && postTokens > pressureLimit) turnsToFirstSummary = turnIndex;
			}
		}
		soFar.push(entry);
	}

	return {
		traceId: trace.id,
		policyId: config.policyId,
		budgetTokens: config.budgetTokens,
		turnCount: trace.turnCount,
		events,
		evictedAtTurn,
		turnsToFirstSummary,
		entries: soFar,
	};
}
