export const MEMORY_VERSION = 1;

export const MEMORY_SCOPES = ["global", "repo", "language", "runtime", "agent", "task-family", "hpc-domain"] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * Stable repository identity used to gate repository-scoped memory.
 *
 * `canonical-path` is deliberately conservative: callers must construct it
 * from the active repository root with `canonicalMemoryRepositoryIdentity`.
 * Symlink aliases collapse to the same key, while moved repositories and Git
 * worktrees remain distinct until a stronger, durable repository identifier
 * is introduced. The path scheme also works for non-Git repositories.
 */
export interface MemoryRepositoryIdentity {
	kind: "canonical-path";
	key: string;
}

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
	/** Preferred repository applicability for `repo` records. */
	repository?: MemoryRepositoryIdentity;
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
	/** Missing or unknown identity excludes every repository-scoped record. */
	activeRepository?: MemoryRepositoryIdentity | null;
}
