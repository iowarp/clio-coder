import type { RunNodeIdentity, RunOutcome, RunReceipt } from "./types.js";
import type { DispatchFailoverCandidate, DispatchFailoverMode } from "./validation.js";

declare const assignmentIdBrand: unique symbol;

/** Logical dispatch identity. The value is always the first attempt's rootRunId. */
export type AssignmentId = string & { readonly [assignmentIdBrand]: "dispatch-assignment" };

export function asAssignmentId(rootRunId: string): AssignmentId {
	return rootRunId as AssignmentId;
}

export interface AttemptRef {
	runId: string;
	attempt: number;
	outcome: RunOutcome;
	node: RunNodeIdentity | null;
	receiptDigest: string;
	retryReason: string | null;
}

export type AssignmentStatus = "running" | "succeeded" | "failed" | "canceled";

export interface AssignmentPolicy {
	maxRetries: number;
	failover: DispatchFailoverMode;
	allowedCandidates: ReadonlyArray<DispatchFailoverCandidate>;
}

export interface DispatchAssignment {
	id: AssignmentId;
	policy: AssignmentPolicy;
	attempts: ReadonlyArray<AttemptRef>;
	status: AssignmentStatus;
	terminalReceipt: RunReceipt | null;
	terminal: Promise<RunReceipt>;
}

interface MutableAssignment {
	id: AssignmentId;
	policy: AssignmentPolicy;
	attempts: AttemptRef[];
	status: AssignmentStatus;
	terminalReceipt: RunReceipt | null;
	terminal: Promise<RunReceipt>;
	resolve: (receipt: RunReceipt) => void;
	reject: (reason: unknown) => void;
}

/** In-memory assignment manager. Attempt receipts remain owned by the run ledger. */
export class AssignmentRegistry {
	readonly #assignments = new Map<AssignmentId, MutableAssignment>();

	open(rootRunId: string, policy: AssignmentPolicy): DispatchAssignment {
		const id = asAssignmentId(rootRunId);
		const existing = this.#assignments.get(id);
		if (existing) return this.#snapshot(existing);

		let resolve!: (receipt: RunReceipt) => void;
		let reject!: (reason: unknown) => void;
		const terminal = new Promise<RunReceipt>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const assignment: MutableAssignment = {
			id,
			policy: {
				...policy,
				allowedCandidates: policy.allowedCandidates.map((candidate) => ({ ...candidate })),
			},
			attempts: [],
			status: "running",
			terminalReceipt: null,
			terminal,
			resolve,
			reject,
		};
		this.#assignments.set(id, assignment);
		return this.#snapshot(assignment);
	}

	recordAttempt(id: AssignmentId, attempt: AttemptRef): void {
		const assignment = this.#require(id);
		if (assignment.attempts.some((entry) => entry.runId === attempt.runId)) return;
		assignment.attempts.push({ ...attempt, node: attempt.node ? { ...attempt.node } : null });
	}

	/** Mark cancellation immediately so retry scheduling observes it. */
	cancel(id: AssignmentId): void {
		const assignment = this.#require(id);
		if (assignment.status === "running") assignment.status = "canceled";
	}

	settle(id: AssignmentId, terminalReceipt: RunReceipt, status: AssignmentStatus): void {
		const assignment = this.#require(id);
		// A canceled assignment still needs its current attempt's immutable receipt
		// to resolve the terminal promise.
		if (assignment.status !== "running" && !(assignment.status === "canceled" && assignment.terminalReceipt === null))
			return;
		assignment.status = assignment.status === "canceled" ? "canceled" : status;
		assignment.terminalReceipt = terminalReceipt;
		assignment.resolve(terminalReceipt);
	}

	/** Reject only when attempt finalization cannot produce an immutable receipt. */
	reject(id: AssignmentId, reason: unknown): void {
		const assignment = this.#require(id);
		if (assignment.status !== "running" && !(assignment.status === "canceled" && assignment.terminalReceipt === null))
			return;
		if (assignment.status === "running") assignment.status = "failed";
		assignment.reject(reason);
	}

	get(id: AssignmentId | string): DispatchAssignment | null {
		const assignment = this.#assignments.get(asAssignmentId(id));
		return assignment ? this.#snapshot(assignment) : null;
	}

	#require(id: AssignmentId): MutableAssignment {
		const assignment = this.#assignments.get(id);
		if (!assignment) throw new Error(`unknown dispatch assignment '${id}'`);
		return assignment;
	}

	#snapshot(assignment: MutableAssignment): DispatchAssignment {
		return {
			id: assignment.id,
			policy: {
				...assignment.policy,
				allowedCandidates: assignment.policy.allowedCandidates.map((candidate) => ({ ...candidate })),
			},
			attempts: assignment.attempts.map((attempt) => ({
				...attempt,
				node: attempt.node ? { ...attempt.node } : null,
			})),
			status: assignment.status,
			terminalReceipt: assignment.terminalReceipt,
			terminal: assignment.terminal,
		};
	}
}
