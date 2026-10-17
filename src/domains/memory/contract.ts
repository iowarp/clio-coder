import type { MemoryCommitScope, MemoryContentStamp } from "./commit-state.js";
import type { RetentionStatus } from "./completion-retention.js";
import type { TaskMemorySnapshot } from "./task-bank.js";
import type { TaskMemoryPolicyDecision, TaskMemoryRoute, TaskMemoryStepUsage } from "./task-memory-policy.js";
import type { TaskMemoryActivityEvent, TaskMemoryGuardianState } from "./task-memory-status.js";

/** Complete host-selected causal unit. Text excludes private reasoning and unseen attachments. */
export interface ObservationSourceUnit {
	readonly refs: readonly string[];
	readonly parts?: readonly { ref: string; toolCallId: string }[];
	readonly digest: string;
	readonly text: string;
	readonly exact: readonly { ref: string; text: string }[];
	readonly toolCallIds: readonly string[];
	readonly successfulResultRefs: readonly string[];
	readonly complete: boolean;
	/** Estimated tokens of the unit's ordinary compaction representation; an observation must beat it. */
	readonly ordinaryTokens?: number;
}

export interface ObservationSource extends MemoryCommitScope {
	readonly checkpoint: { readonly id: string; readonly digest: string } | null;
	readonly units: readonly ObservationSourceUnit[];
}

export interface ObservationNote {
	readonly id: string;
	readonly category: "constraint" | "decision" | "outcome" | "unresolved" | "context";
	readonly status: "assertion" | "proposal" | "attempt" | "verified" | "unknown";
	readonly text: string;
	readonly refs: readonly string[];
	readonly supersedes?: readonly string[];
}

export interface SessionObservation {
	readonly version: 1;
	readonly id: string;
	readonly scope: MemoryCommitScope;
	readonly authority: MemoryContentStamp;
	readonly checkpoint: ObservationSource["checkpoint"];
	readonly revision: string;
	readonly priorObservationRevision: string | null;
	readonly coverage: readonly ObservationSourceUnit[];
	readonly sourceDigest: string;
	readonly sourceTokens: number;
	readonly notes: readonly ObservationNote[];
	readonly rendered: string;
	readonly digest: string;
	readonly createdAt: string;
	readonly route: TaskMemoryRoute | null;
	readonly usage: TaskMemoryStepUsage | null;
	readonly inputs: readonly { id: string; digest: string }[];
}

/** Small ledger metadata. Meaning never depends on preparation sidecars. */
export interface MemoryConsumptionReceipt {
	readonly version: 1;
	readonly scope: MemoryCommitScope;
	readonly offerId: string;
	readonly batches: readonly { id: string; digest: string }[];
	readonly coverageDigest: string;
	readonly checkpoint: ObservationSource["checkpoint"];
}

export interface MemoryCompactionOffer {
	readonly text: string;
	readonly receipt: MemoryConsumptionReceipt;
	readonly isCurrent: () => boolean;
	/** The compactor chose this offer; the request sizes it priced the choice on. */
	readonly onUse?: (use: MemoryOfferUse) => void;
}

/** Estimated summarizer input with the ordinary slice and with the offer substituted (SPEC R15). */
export interface MemoryOfferUse {
	readonly originalInputTokens: number;
	readonly substitutedInputTokens: number;
}

export interface MemoryOfferInput {
	readonly source: ObservationSource;
	readonly ordinary: string;
	readonly serialize: (refs: readonly string[]) => string;
}

export interface ObservationStatus {
	readonly enabled: boolean;
	readonly scope: MemoryCommitScope | null;
	readonly unobserved: number;
	readonly ready: number;
	readonly offered: number;
	readonly consumed: number;
	readonly sourceTokens: number;
	readonly noteTokens: number;
	readonly sourceTargetTokens: number;
	readonly journalTargetTokens: number;
	readonly budgetBasis: "main" | "memory" | "unknown";
	readonly reflection: "idle" | "preparing";
	readonly lastCommit: string | null;
	readonly lastReceipt: string | null;
	readonly lastReason: string | null;
	readonly route: TaskMemoryRoute | null;
	readonly usage: TaskMemoryStepUsage | null;
	readonly durationMs: number | null;
}

/** Last prepared memory selection. Submission is recorded only when the actual request carries its exact section. */
export interface MemoryPromptSelection {
	readonly turnId: string | null;
	readonly repository: string | null;
	readonly runtime: string;
	readonly model: string;
	readonly preparedAt: string;
	readonly submittedAt: string | null;
	readonly section: string;
	readonly tokenBudget: number;
	readonly items: readonly {
		readonly id: string;
		readonly text: string;
		readonly scope: string;
		readonly rank: number;
		readonly reason: "selected" | "token-budget" | "item-limit";
	}[];
}

/** Foreign domains receive this query surface only. */
export interface MemoryContract {
	promptSelection?(): MemoryPromptSelection | null;
	retentionStatus(): RetentionStatus;
	observationStatus(): ObservationStatus;
	taskSnapshot(): TaskMemorySnapshot;
	interventionStatus(): {
		stepInFlight: boolean;
		lastDecision: TaskMemoryPolicyDecision | null;
		activity: readonly TaskMemoryActivityEvent[];
	};
	guardianState(): TaskMemoryGuardianState;
}

/** Composition supplies ledger authority and durability through a separate command port. */
export interface MemoryObservationCommands {
	offerCompaction(input: MemoryOfferInput): MemoryCompactionOffer | null;
	recoverConsumption(
		scope: MemoryCommitScope,
		commits: readonly { commitId: string; receipt: MemoryConsumptionReceipt }[],
	): void;
	consume(commitId: string, receipt: MemoryConsumptionReceipt): void;
}
