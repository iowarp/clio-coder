import type { ActiveRoutingPosture, ActiveRoutingRole } from "../../core/defaults.js";
import type { AgentCapabilityClass } from "../agents/spec.js";
import {
	type AssignmentAttemptStartEvent,
	type AssignmentEventStream,
	createAssignmentEventStream,
} from "./assignment-events.js";
import type { DispatchRequest } from "./contract.js";
import { withAttemptRole } from "./execution-role.js";
import { type RouteDecisionV1, routeCandidateKey } from "./route-decision.js";
import type { RoutingPosture } from "./route-policy.js";
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

export type AssignmentStatus = "running" | "succeeded" | "failed" | "canceled" | "timed_out";

export interface AssignmentPolicy {
	maxRetries: number;
	failover: DispatchFailoverMode;
	allowedCandidates: ReadonlyArray<DispatchFailoverCandidate>;
}

export interface RoutingActivationSnapshot {
	activeRoles: ReadonlyArray<ActiveRoutingRole>;
	activePostures: ReadonlyArray<ActiveRoutingPosture>;
}

/** Activation is explicit in both dimensions and never widens mutation authority. */
export function activeRoutingEnabled(input: {
	settings: RoutingActivationSnapshot;
	role: DispatchRequest["executionRole"];
	posture: RoutingPosture;
	capabilityClass: AgentCapabilityClass;
	failover: DispatchFailoverMode;
}): boolean {
	if (input.posture === "manual" || input.failover !== "approved") return false;
	if (input.capabilityClass !== "read-only" && input.capabilityClass !== "verification") return false;
	return (
		input.settings.activeRoles.includes(input.role as ActiveRoutingRole) &&
		input.settings.activePostures.includes(input.posture as ActiveRoutingPosture)
	);
}

/** Bind an admitted active decision back onto the exact dispatch tuple. */
export function applyActiveRouteSelection(req: DispatchRequest, decision: RouteDecisionV1): DispatchRequest {
	if (decision.mode !== "active") throw new Error("dispatch: cannot apply a non-active route decision");
	if (routeCandidateKey(decision.selected) !== routeCandidateKey(decision.executedRoute)) {
		throw new Error("dispatch: active decision selected and executed route identities differ");
	}
	const executionRole = withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0);
	if (decision.selected.agentId !== req.agentId || decision.selected.executionRole !== executionRole) {
		throw new Error("dispatch: active route selection cannot change agent or execution role");
	}
	const envelope = [decision.selected, ...decision.approvedFallbacks].map((candidate) => ({
		agentId: candidate.agentId,
		target: candidate.targetId,
		model: candidate.modelId,
		node: candidate.nodeId,
	}));
	const selected: DispatchRequest = {
		...req,
		target: decision.selected.targetId,
		model: decision.selected.modelId,
		workerRuntime: decision.selected.runtimeId,
		node: decision.selected.nodeId,
		failover: "approved",
		allowedCandidates: envelope,
	};
	if (decision.selected.thinkingLevel === undefined) {
		delete selected.thinkingLevel;
	} else if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(decision.selected.thinkingLevel)) {
		throw new Error(`dispatch: active route selected unsupported thinking level '${decision.selected.thinkingLevel}'`);
	} else {
		selected.thinkingLevel = decision.selected.thinkingLevel as NonNullable<DispatchRequest["thinkingLevel"]>;
	}
	return selected;
}

/** Fail closed if lifecycle or placement changed any sealed active identity field. */
export function assertActiveRouteIdentity(decision: RouteDecisionV1, actual: RouteDecisionV1["selected"]): void {
	if (routeCandidateKey(actual) !== routeCandidateKey(decision.selected)) {
		throw new Error("dispatch: active route identity drifted after lifecycle or placement resolution");
	}
}

export interface DispatchAssignment {
	id: AssignmentId;
	policy: AssignmentPolicy;
	attempts: ReadonlyArray<AttemptRef>;
	status: AssignmentStatus;
	terminalReceipt: RunReceipt | null;
	/**
	 * Why the assignment ended here when the terminal receipt does not say so
	 * itself: a retry denied at admission leaves the previous attempt's sealed
	 * receipt as terminal evidence, and that receipt cannot record the denial.
	 */
	outcomeDetail: string | null;
	terminal: Promise<RunReceipt>;
	/**
	 * Every attempt's frames in order, separated by `attempt_start`. Shared
	 * single-consumer iterator: the snapshot hands out the same stream the
	 * assignment owns, exactly as it hands out the same terminal promise.
	 */
	events: AsyncIterableIterator<unknown>;
}

interface MutableAssignment {
	id: AssignmentId;
	policy: AssignmentPolicy;
	attempts: AttemptRef[];
	status: AssignmentStatus;
	terminalReceipt: RunReceipt | null;
	outcomeDetail: string | null;
	terminal: Promise<RunReceipt>;
	stream: AssignmentEventStream;
	resolve: (receipt: RunReceipt) => void;
	reject: (reason: unknown) => void;
}

/** In-memory assignment manager. Attempt receipts remain owned by the run ledger. */
export class AssignmentRegistry {
	readonly #assignments = new Map<AssignmentId, MutableAssignment>();
	readonly #onStreamError: ((error: unknown) => void) | undefined;

	constructor(options: { onStreamError?: (error: unknown) => void } = {}) {
		this.#onStreamError = options.onStreamError;
	}

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
			outcomeDetail: null,
			terminal,
			stream: createAssignmentEventStream(this.#onStreamError !== undefined ? { onError: this.#onStreamError } : {}),
			resolve,
			reject,
		};
		this.#assignments.set(id, assignment);
		return this.#snapshot(assignment);
	}

	/**
	 * Fold one attempt's frames into the assignment stream. The marker precedes
	 * the frames so a consumer resets accumulated state before the new attempt's
	 * output arrives; attempt 1 carries no marker.
	 */
	attachAttempt(id: AssignmentId, source: AsyncIterable<unknown>, marker?: AssignmentAttemptStartEvent): void {
		this.#require(id).stream.attach(source, marker);
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
		// A canceled assignment produces no further attempts, so the stream ends
		// now rather than waiting on a worker that is being torn down.
		assignment.stream.abort();
	}

	settle(id: AssignmentId, terminalReceipt: RunReceipt, status: AssignmentStatus, outcomeDetail?: string): void {
		const assignment = this.#require(id);
		// A canceled assignment still needs its current attempt's immutable receipt
		// to resolve the terminal promise.
		if (assignment.status !== "running" && !(assignment.status === "canceled" && assignment.terminalReceipt === null))
			return;
		assignment.status = assignment.status === "canceled" ? "canceled" : status;
		assignment.terminalReceipt = terminalReceipt;
		if (outcomeDetail !== undefined) assignment.outcomeDetail = outcomeDetail;
		assignment.stream.close();
		assignment.resolve(terminalReceipt);
	}

	/** Reject only when attempt finalization cannot produce an immutable receipt. */
	reject(id: AssignmentId, reason: unknown): void {
		const assignment = this.#require(id);
		if (assignment.status !== "running" && !(assignment.status === "canceled" && assignment.terminalReceipt === null))
			return;
		if (assignment.status === "running") assignment.status = "failed";
		assignment.stream.close();
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
			outcomeDetail: assignment.outcomeDetail,
			terminal: assignment.terminal,
			events: assignment.stream.events,
		};
	}
}
