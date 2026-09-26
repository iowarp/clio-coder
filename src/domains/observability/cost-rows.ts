/**
 * The /usage fold: cost entries grouped per provider and attributed model,
 * with the calls made beside the conversation counted by label. The terminal
 * overlay and the ACP host (`_clio-coder/usage/read`) both read these rows, so
 * a client never folds the ledger differently from the terminal.
 */

import type { ResponseModelIdObservationCounts } from "../../core/response-model-id.js";
import { addResponseModelIdObservationCounts } from "../../core/response-model-id.js";
import { aggregateCostAmounts, type CostAggregate, type CostEntry } from "./cost.js";

export interface CostRow {
	providerId: string;
	attributedModelId: string;
	requestedModelIds: string[];
	responseModelIdObservationCounts: ResponseModelIdObservationCounts;
	runs: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	apiCalls: number;
	/** Calls in this row that were `/btw` side questions rather than turns. */
	sideQuestions: number;
	/** Calls in this row that were `/handoff` extraction rounds rather than turns. */
	handoffs: number;
	/** Calls in this row that were session pre-warms rather than turns. */
	prewarms: number;
	/** Calls in this row that were proactive-memory steps on the background target. */
	backgroundMemory: number;
	failedCompaction: number;
	cost: CostAggregate;
}

export function aggregateCostEntries(entries: ReadonlyArray<CostEntry>): CostRow[] {
	const grouped = new Map<
		string,
		{
			row: Omit<CostRow, "cost" | "requestedModelIds" | "responseModelIdObservationCounts">;
			requestedModelIds: Set<string>;
			responseModelIdObservationCounts: ResponseModelIdObservationCounts;
			entries: CostEntry[];
		}
	>();
	for (const entry of entries) {
		const key = `${entry.providerId}::${entry.attributedModelId}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.row.runs += 1;
			existing.row.tokens += entry.tokens;
			existing.row.input += entry.input;
			existing.row.output += entry.output;
			existing.row.cacheRead += entry.cacheRead;
			existing.row.cacheWrite += entry.cacheWrite;
			existing.row.reasoningTokens += entry.reasoningTokens;
			existing.row.apiCalls += entry.apiCalls ?? 1;
			if (entry.label === "side-question") existing.row.sideQuestions += 1;
			if (entry.label === "handoff") existing.row.handoffs += 1;
			if (entry.label === "prewarm") existing.row.prewarms += 1;
			if (entry.label === "background-memory") existing.row.backgroundMemory += 1;
			if (entry.label === "failed-compaction") existing.row.failedCompaction += 1;
			for (const requestedModelId of entry.requestedModelIds) existing.requestedModelIds.add(requestedModelId);
			addResponseModelIdObservationCounts(
				existing.responseModelIdObservationCounts,
				entry.responseModelIdObservationCounts,
			);
			existing.entries.push(entry);
			continue;
		}
		grouped.set(key, {
			row: {
				providerId: entry.providerId,
				attributedModelId: entry.attributedModelId,
				runs: 1,
				tokens: entry.tokens,
				input: entry.input,
				output: entry.output,
				cacheRead: entry.cacheRead,
				cacheWrite: entry.cacheWrite,
				reasoningTokens: entry.reasoningTokens,
				apiCalls: entry.apiCalls ?? 1,
				sideQuestions: entry.label === "side-question" ? 1 : 0,
				handoffs: entry.label === "handoff" ? 1 : 0,
				prewarms: entry.label === "prewarm" ? 1 : 0,
				backgroundMemory: entry.label === "background-memory" ? 1 : 0,
				failedCompaction: entry.label === "failed-compaction" ? 1 : 0,
			},
			requestedModelIds: new Set(entry.requestedModelIds),
			responseModelIdObservationCounts: { ...entry.responseModelIdObservationCounts },
			entries: [entry],
		});
	}
	const rows = Array.from(grouped.values(), ({ row, entries, requestedModelIds, responseModelIdObservationCounts }) => ({
		...row,
		requestedModelIds: [...requestedModelIds].sort(),
		responseModelIdObservationCounts,
		cost: aggregateCostAmounts(entries.map((entry) => ({ usd: entry.usd, provenance: entry.provenance }))),
	}));
	rows.sort((a, b) => {
		if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
		if (a.attributedModelId !== b.attributedModelId) return a.attributedModelId < b.attributedModelId ? -1 : 1;
		return 0;
	});
	return rows;
}
