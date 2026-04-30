export const MEMORY_VERSION = 1;

export const MEMORY_SCOPES = ["global", "repo", "language", "runtime", "agent", "task-family", "hpc-domain"] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryRecord {
	id: string;
	scope: MemoryScope;
	key: string;
	lesson: string;
	evidenceRefs: string[];
	appliesWhen: string[];
	avoidWhen: string[];
	confidence: number;
	createdAt: string;
	lastVerifiedAt?: string;
	regressions?: string[];
	approved: boolean;
	rejectedAt?: string;
}

export interface MemoryStoreFile {
	version: 1;
	records: MemoryRecord[];
}

export type MemoryStatus = "proposed" | "approved" | "rejected";

export interface MemoryValidationIssue {
	path: string;
	message: string;
}

export type MemoryRecordValidationResult =
	| { valid: true; record: MemoryRecord }
	| { valid: false; issues: MemoryValidationIssue[] };

export type MemoryStoreValidationResult =
	| { valid: true; store: MemoryStoreFile }
	| { valid: false; issues: MemoryValidationIssue[] };

export interface MemoryProposalResult {
	record: MemoryRecord;
	created: boolean;
}

export interface MemoryPruneResult {
	pruned: MemoryRecord[];
	kept: MemoryRecord[];
}

export interface MemoryRetrievalOptions {
	scopes?: ReadonlyArray<MemoryScope>;
	tokenBudget: number;
}
