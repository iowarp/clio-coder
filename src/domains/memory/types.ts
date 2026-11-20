/** The store version this build writes once any record carries claim identity, revisions or delivery counters. */
export const MEMORY_VERSION = 2;
/**
 * Stores written before claim identity. They are read as they are, and a store whose records carry nothing newer is
 * written back at this version, so an older build keeps reading it until a record needs the newer shape.
 */
export const MEMORY_LEGACY_VERSION = 1;

export const MEMORY_SCOPES = ["global", "repo", "language", "runtime", "agent", "task-family", "hpc-domain"] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * Stable repository identity used to gate repository-scoped memory.
 *
 * `canonical-path` is deliberately conservative: callers must construct it
 * from the active repository root with `canonicalMemoryRepositoryIdentity`.
 * Symlink aliases and linked Git worktrees collapse to the main checkout's
 * key, while moved repositories remain distinct until a stronger, durable
 * repository identifier is introduced. The path scheme also works for non-Git repositories.
 */
export interface MemoryRepositoryIdentity {
	kind: "canonical-path";
	key: string;
	/** Root commit of the repository when known; records and the active repository must agree when both carry one. */
	fingerprint?: string;
}

export interface MemoryRuntimeIdentity {
	kind: "runtime";
	key: string;
}

export interface MemoryAgentIdentity {
	kind: "agent";
	key: string;
}

export interface MemoryPromotionRedaction {
	appliedBeforePersistence: true;
	replacementCount: number;
	sourceFields: string[];
}

/** What an operator-stated memory says it is; the operator's words or the background classifier chose it. */
export const OPERATOR_STATED_KINDS = ["fact", "preference", "rule", "command"] as const;
export type OperatorStatedKind = (typeof OPERATOR_STATED_KINDS)[number];

export interface MemoryRecordProvenance {
	/** `operator-stated`: the operator told Clio to remember it in a submitted prompt; their words are the approval. */
	sourceKind: "evidence" | "task-bank-entry" | "handoff-snapshot" | "operator-stated";
	/** Only on `operator-stated` records. */
	statedKind?: OperatorStatedKind;
	evidenceId?: string;
	sourceSessionId?: string;
	sourceEntryId?: string;
	sourceEntryKind?: "knowledge" | "procedural";
	sourceEntryCreatedAt?: string;
	sourceEntryLastTouchedAt?: string;
	redaction?: MemoryPromotionRedaction;
}

export const MEMORY_OBSERVATION_KINDS = ["delivered", "held", "contradicted"] as const;
export type MemoryObservationKind = (typeof MEMORY_OBSERVATION_KINDS)[number];
/**
 * Verdicts a record keeps. The oldest fall off first, except the newest `contradicted`, which stays pinned; deliveries
 * are counted outside the window (`deliveredCount`), so they never push a verdict out.
 */
export const MEMORY_OBSERVATIONS_MAX = 32;

/**
 * What a session saw happen to a claim. `held` is a demonstration of it, `contradicted` a failure of it. A verdict
 * written since claim identity is scoped: the claim revision it judged, the checkout's branch and head, and whether
 * the session had been shown the note first. A `delivered` entry, or a verdict without a revision, comes from a
 * store written before; it is read as it is and judges no current revision.
 */
export interface MemoryObservation {
	at: string;
	sessionId: string;
	kind: MemoryObservationKind;
	revision?: string;
	branch?: string;
	head?: string;
	prompted?: boolean;
}

/** One command a claim binds: its argv after the identity rewrites, and the evidence key over them. */
export interface MemoryClaimCommand {
	assignments: string[];
	argv: string[];
	key: string;
	/** Index into `argv` of a declared scratch-path parameter. */
	scratchParameter?: number;
}

/**
 * What a record claims, the body of its identity. A command claim is its argv pattern; a fix claim is the pair of
 * the failed and the fixed pattern; a source claim is one quoted span of one file, so two quotes in one file are two
 * claims. Wording is not part of it: two wordings of one claim are two revisions of one record.
 */
export type MemoryClaim =
	| { kind: "command"; command: MemoryClaimCommand }
	| { kind: "fix"; failed: MemoryClaimCommand; fixed: MemoryClaimCommand }
	| { kind: "source"; path: string; spanHash: string };

/** One wording of a claim and the session that wrote it; the last entry is the current revision. */
export interface MemoryRevision {
	revision: string;
	lesson: string;
	at: string;
	sessionId: string;
}

/** Wordings a record keeps; the oldest fall off first and the current one always stays. */
export const MEMORY_REVISIONS_MAX = 8;

/** Who flipped `approved`. Absent on records approved before the guardian gate existed. */
export interface MemoryApproval {
	by: "operator" | "guardian";
	at: string;
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
	/** Exact runtime applicability for `runtime` records. */
	runtime?: MemoryRuntimeIdentity;
	/** Exact agent applicability for `agent` records. */
	agent?: MemoryAgentIdentity;
	/** Source and pre-persistence redaction facts for reviewed proposals. */
	provenance?: MemoryRecordProvenance;
	approval?: MemoryApproval;
	observations?: MemoryObservation[];
	/** Absent on records written before claim identity; their claim is read from their evidence refs. */
	claim?: MemoryClaim;
	/** Present once a second wording arrived. */
	revisions?: MemoryRevision[];
	/** Deliveries recorded since the counter existed; legacy `delivered` observations join it on the first mutation. */
	deliveredCount?: number;
	lastDeliveredAt?: string;
}

export interface MemoryStoreFile {
	version: typeof MEMORY_VERSION | typeof MEMORY_LEGACY_VERSION;
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

export interface MemoryProposalResult {
	record: MemoryRecord;
	created: boolean;
}

export interface MemoryRetrievalOptions {
	scopes?: ReadonlyArray<MemoryScope>;
	tokenBudget: number;
	/** Missing or unknown identity excludes every repository-scoped record. */
	activeRepository?: MemoryRepositoryIdentity | null;
	/** Missing or unknown identity excludes every runtime-scoped record. */
	activeRuntime?: MemoryRuntimeIdentity | null;
	/** Missing or unknown identity excludes every agent-scoped record. */
	activeAgent?: MemoryAgentIdentity | null;
}
