import { memoryTerms, rankMemoryByRelevance } from "./relevance.js";
import type { TaskMemoryEntry, TaskMemorySnapshot } from "./task-bank.js";
import type { MemoryRecord, MemoryRetrievalOptions } from "./types.js";

export const MEMORY_RECALL_DEFAULT_LIMIT = 8;
export const MEMORY_RECALL_MAX_LIMIT = 20;

export type MemoryRecallHit =
	| { source: "task"; id: string; kind: "knowledge" | "procedural"; text: string; score: number }
	| {
			source: "durable";
			id: string;
			scope: MemoryRecord["scope"];
			text: string;
			appliesWhen: string[];
			avoidWhen: string[];
			score: number;
	  };

export interface MemoryRecallInput {
	query: string;
	limit?: number;
	/** The session's task bank; status never leaves it through recall. */
	bank: TaskMemorySnapshot | null;
	records: ReadonlyArray<MemoryRecord>;
	eligibility: Omit<MemoryRetrievalOptions, "tokenBudget">;
}

/**
 * Read-only lookup over both stores. Durable records pass the same eligibility
 * gates as prompt injection before lexical ranking; bank entries score by the
 * same term overlap. Only positive matches return, so an unrelated query reads
 * as no memory rather than as the newest records.
 */
export function recallMemory(input: MemoryRecallInput): MemoryRecallHit[] {
	const limit = clampLimit(input.limit);
	const queryTerms = memoryTerms(input.query).slice(0, 64);
	if (queryTerms.length === 0) return [];
	const bankEntries: TaskMemoryEntry[] = [...(input.bank?.knowledge ?? []), ...(input.bank?.procedural ?? [])];
	const taskHits: MemoryRecallHit[] = bankEntries.flatMap((entry) => {
		if (entry.kind === "status") return [];
		const entryTerms = new Set(memoryTerms(entry.content));
		const score = queryTerms.filter((term) => entryTerms.has(term)).length;
		return score > 0 ? [{ source: "task", id: entry.id, kind: entry.kind, text: entry.content, score }] : [];
	});
	const durableHits: MemoryRecallHit[] = rankMemoryByRelevance(input.records, input.eligibility, {
		taskText: input.query,
	})
		.filter((candidate) => candidate.score > 0)
		.map(({ record, score }) => ({
			source: "durable",
			id: record.id,
			scope: record.scope,
			text: record.lesson,
			appliesWhen: [...record.appliesWhen],
			avoidWhen: [...record.avoidWhen],
			score,
		}));
	// Stable sort: on equal scores session entries lead, then each store's own order.
	return [...taskHits, ...durableHits].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function renderMemoryRecall(hits: ReadonlyArray<MemoryRecallHit>): string {
	if (hits.length === 0) return "No task or approved durable memory matched the query.";
	const lines: string[] = [];
	for (const hit of hits) {
		const text = compact(hit.text);
		if (hit.source === "task") {
			lines.push(`- [${hit.id}] task ${hit.kind}: ${text}`);
			continue;
		}
		lines.push(`- [${hit.id}] durable scope=${hit.scope}: ${text}`);
		if (hit.appliesWhen.length > 0) lines.push(`  Applies when: ${hit.appliesWhen.map(compact).join("; ")}.`);
		if (hit.avoidWhen.length > 0) lines.push(`  Avoid when: ${hit.avoidWhen.map(compact).join("; ")}.`);
	}
	return lines.join("\n");
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return MEMORY_RECALL_DEFAULT_LIMIT;
	return Math.min(MEMORY_RECALL_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
