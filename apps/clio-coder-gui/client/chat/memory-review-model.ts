/**
 * The board's "Waiting for review" list, decided without React. A pending lesson is shown with every
 * fact the CLI's review shows, so approving it here is the same decision as `memory approve`.
 */

import type { MemoryDecision, MemoryReviewRecord } from "../../contracts/review.js";

export const MEMORY_REVIEW_EMPTY = "No lessons are waiting for review.";

export interface MemoryReviewRow {
	id: string;
	/** `repo · /path/to/project`, or the scope alone when it names no repository. */
	scope: string;
	key: string;
	lesson: string;
	appliesWhen: string | null;
	avoidWhen: string | null;
	confidence: string;
	evidence: string | null;
}

export function memoryReviewHeading(count: number): string {
	return `Waiting for review (${count})`;
}

export function memoryReviewRows(records: readonly MemoryReviewRecord[]): MemoryReviewRow[] {
	return records.map((record) => ({
		id: record.id,
		scope: record.repository ? `${record.scope} · ${record.repository.key}` : record.scope,
		key: record.key,
		lesson: record.lesson,
		appliesWhen: record.appliesWhen.length ? `Applies when ${record.appliesWhen.join("; ")}` : null,
		avoidWhen: record.avoidWhen.length ? `Avoid when ${record.avoidWhen.join("; ")}` : null,
		confidence: `Confidence ${Math.round(record.confidence * 100)}%`,
		evidence: record.evidenceRefs.length ? `Evidence ${record.evidenceRefs.join(", ")}` : null,
	}));
}

export function memoryDecisionNote(id: string, decision: MemoryDecision): string {
	return decision === "approve" ? `Approved ${id}.` : `Rejected ${id}.`;
}
