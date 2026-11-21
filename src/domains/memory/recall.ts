import { COMMAND_EVIDENCE_REF_PREFIX } from "./command-evidence.js";
import { recordClaim } from "./promotion.js";
import { memoryTerms, rankMemoryByRelevance } from "./relevance.js";
import type { TaskMemoryEntry, TaskMemorySnapshot } from "./task-bank.js";
import { AGENT_NOTE_EVIDENCE_PREFIX, type MemoryRecord, type MemoryRetrievalOptions } from "./types.js";

export const MEMORY_RECALL_DEFAULT_LIMIT = 8;
export const MEMORY_RECALL_MAX_LIMIT = 20;

export type MemoryRecallHit =
	| { source: "task"; id: string; kind: "knowledge" | "procedural"; text: string; score: number }
	| {
			source: "durable";
			id: string;
			scope: MemoryRecord["scope"];
			/** A lesson is promoted; a note is not, and nothing has confirmed it. */
			layer: "lesson" | "note";
			evidence: MemoryRecallEvidence;
			text: string;
			appliesWhen: string[];
			avoidWhen: string[];
			score: number;
	  };

/** What stands behind a durable hit: a command, a failed-then-fixed pair, a quoted source, the operator, or nothing. */
type MemoryRecallEvidence = "command" | "fix" | "source" | "operator" | "none";

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
 * gates as prompt injection before lexical ranking, notes included: a note is
 * gated as if it were promoted and labelled as the unconfirmed note it is. Bank
 * entries score by the same term overlap. Only positive matches return, so an
 * unrelated query reads as no memory rather than as the newest records.
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
	const notes = new Set(input.records.filter(memoryNoteRecord).map((record) => record.id));
	const gated = input.records.map((record) => (notes.has(record.id) ? { ...record, approved: true } : record));
	const durableHits: MemoryRecallHit[] = rankMemoryByRelevance(gated, input.eligibility, {
		taskText: input.query,
	})
		.filter((candidate) => candidate.score > 0)
		.map(({ record, score }) => ({
			source: "durable",
			id: record.id,
			scope: record.scope,
			layer: notes.has(record.id) ? "note" : "lesson",
			evidence: recallEvidence(record),
			text: record.lesson,
			appliesWhen: [...record.appliesWhen],
			avoidWhen: [...record.avoidWhen],
			score,
		}));
	// Stable sort: on equal scores session entries lead, then each store's own order.
	return [...taskHits, ...durableHits].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function renderMemoryRecall(hits: ReadonlyArray<MemoryRecallHit>): string {
	if (hits.length === 0) return "No task memory, lesson or note matched the query.";
	const lines: string[] = [];
	for (const hit of hits) {
		const text = compact(hit.text);
		if (hit.source === "task") {
			lines.push(`- [${hit.id}] task ${hit.kind}: ${text}`);
			continue;
		}
		const layer = hit.layer === "note" ? "note, unverified" : "lesson";
		lines.push(`- [${hit.id}] durable scope=${hit.scope} ${layer}, ${EVIDENCE_LABEL[hit.evidence]}: ${text}`);
		if (hit.appliesWhen.length > 0) lines.push(`  Applies when: ${hit.appliesWhen.map(compact).join("; ")}.`);
		if (hit.avoidWhen.length > 0) lines.push(`  Avoid when: ${hit.avoidWhen.map(compact).join("; ")}.`);
	}
	return lines.join("\n");
}

const EVIDENCE_LABEL: Readonly<Record<MemoryRecallEvidence, string>> = {
	command: "command evidence",
	fix: "a failed command and the success that fixed it",
	source: "quoted from a repository file",
	operator: "stated by the operator",
	none: "no evidence",
};

/**
 * An unpromoted repository record recall may show as a note: undecided, uncontradicted, and resting on a command or
 * source evidence ref, or written by the main agent through `memory_note` with neither (DESIGN 4.4, Note row). A
 * proposal with no such ref is not a note.
 */
function memoryNoteRecord(record: MemoryRecord): boolean {
	return (
		!record.approved &&
		record.rejectedAt === undefined &&
		(record.regressions?.length ?? 0) === 0 &&
		record.scope === "repo" &&
		(record.evidenceRefs.some((ref) => /^(?:command|source):/u.test(ref)) ||
			record.provenance?.evidenceId?.startsWith(AGENT_NOTE_EVIDENCE_PREFIX) === true)
	);
}

function recallEvidence(record: MemoryRecord): MemoryRecallEvidence {
	if (record.provenance?.sourceKind === "operator-stated") return "operator";
	const claim = recordClaim(record);
	if (claim !== null) return claim.kind;
	if (record.evidenceRefs.some((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX))) return "command";
	if (record.evidenceRefs.some((ref) => ref.startsWith("source:"))) return "source";
	return "none";
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return MEMORY_RECALL_DEFAULT_LIMIT;
	return Math.min(MEMORY_RECALL_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
