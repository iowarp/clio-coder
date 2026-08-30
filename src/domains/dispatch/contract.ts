import type { SafeEventBus } from "../../core/event-bus.js";
import type { ResultContract } from "../agents/result-contract.js";
import type { AgentAutomationAuthority, AgentSpec } from "../agents/spec.js";
import type { CostProvenance } from "../providers/index.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import type { AssignmentId, DispatchAssignment } from "./assignment.js";
import type { DurableAssignmentRecord } from "./assignment-store.js";
import type { DetachedBatchRecord, RegisterDetachedBatchInput } from "./batch-store.js";
import type { RunToolBudgetEnvelope } from "./budget-envelope.js";
import type { ExecutionRole } from "./execution-role.js";
import type { DispatchReservationRecord, ReservationTopology } from "./reservation-store.js";
import type { ApprovedAssignmentRoute } from "./route-approval.js";
import type { RouteDecisionV1 } from "./route-decision.js";
import type { RunEnvelope, RunLineage, RunNodeIdentity, RunPhaseDurations, RunReceipt, RunStatus } from "./types.js";
import type { DispatchFailoverCandidate, JobSpec } from "./validation.js";
import type { WriteBoundaryAttribution } from "./write-boundary.js";

export interface DispatchRequest extends JobSpec {
	/** Coordinator-owned result contract override for a fleet plan step. */
	resultContractOverride?: ResultContract;
	/** Gate path whose post-run hash is sealed into this step's receipt. */
	fleetGateReceipt?: { path: string };
	/** Orchestrator-prepared task worktree state. Model arguments cannot author it. */
	taskWorktree?: {
		root: string;
		runId: string;
		path: string;
		branch: string;
		base: string;
		ownerToken: string;
	};
	/** Run identity allocated before task worktree creation. Model arguments cannot author it. */
	runIdHint?: string;
	/** Parent checkout frozen by plan approval for task worktree application. */
	taskWorktreeDestination?: string;
	/** Admission-resolved commands. Model text never enters these argv vectors. */
	resolvedVerification?: ReadonlyArray<{
		check: string;
		argv: ReadonlyArray<string>;
		cwd: string;
		timeoutMs: number;
	}>;
	/**
	 * Semantic role this request's first attempt runs under. Derived once by
	 * `execution-role.ts` at request construction, never authored by a model, and
	 * never inferred later: it is what separates builder, gate, reconnaissance,
	 * and recovery route statistics from each other.
	 */
	executionRole: ExecutionRole;
	/** Concrete baseline plus trusted auto authority; the literal id "auto" never crosses this boundary. */
	agentSelection?: {
		version: 1;
		mode: "auto";
		baselineAgentId: string;
		approvedAuthorities: ReadonlyArray<AgentAutomationAuthority>;
		authorityBasis: "operator-plan-approval" | "full-auto-policy";
	};
	systemPrompt?: string;
	/** Trusted side-store lease reference; never serialized into a worker spec or receipt. */
	reservation?: { ownerId: string; memberId: string };
	/** Registry-authenticated active approval; never accepted from model JSON. */
	routeApproval?: ApprovedAssignmentRoute;
	/** Resolver-authored active decision for this approved recovery attempt. */
	routeAttemptDecision?: ApprovedAssignmentRoute["decision"];
	/**
	 * The agent ledger this run coordinates on. Set by the dispatch modes that
	 * run two or more concurrent peers; absent everywhere else, and its absence
	 * strips the ledger tool from this run's admitted surface.
	 */
	ledger?: { id: string; sequence: number };
	/** Absolute root-assignment deadline derived once from the approved duration. */
	assignmentDeadlineAt?: number;
	/**
	 * Tool call the caller was executing when it built this request. Stamped by
	 * the dispatch tool from its own invocation id and republished on
	 * DispatchStarted so a transcript can nest the worker under the tool segment
	 * that spawned it. It is deliberately NOT part of JobSpec: model JSON must
	 * never be able to claim parentage of a tool call it did not make, so the
	 * validation projection strips it like the reservation and ledger refs.
	 */
	parentToolCallId?: string;
}

/** Internal, non-serializable admission hook for transactional resource owners. */
export interface DispatchAdmissionObserver {
	onAdmitted(run: { runId: string; pid: number | null; runtimeKind: RunEnvelope["runtimeKind"] }): void;
}

/** Side-effect-free effective routing used to construct a dispatch approval artifact. */
export interface DispatchPlanTaskResolution {
	agentId: string;
	/** Stable identity of the recipe surface this route would execute. */
	specFingerprint: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	/** Canonical inference scheduler identity and its independent request-slot bound. */
	endpoint?: { key: string; label: string; limit: number };
	node: RunNodeIdentity;
	/** Effective thinking control for this route; null when the runtime has none. */
	thinkingLevel: string | null;
	/** Effective tool surface after the runtime narrows it; part of route identity. */
	toolSignature: string;
	endpointIdentityHash: string;
	settingsFingerprint: string;
	/** Conservative effective-pricing estimate; unknown pricing is never zero. */
	costUpperBoundUsd: number;
	/** False when the numeric estimate is only the unknown-pricing admission sentinel. */
	costUpperBoundKnown: boolean;
	/** Required plan projection: null means this task remains shadow/fixed. */
	routeApproval: ApprovedAssignmentRoute | null;
}

export interface DispatchAgentPlanResolution {
	resolution: DispatchPlanTaskResolution;
	decision: RouteDecisionV1;
	agentSpec: AgentSpec;
}

export interface DispatchAgentPlanInput {
	request: DispatchRequest;
	expectedResultContract: ResultContract["kind"];
	requestedAuthority: AgentAutomationAuthority;
	authorization: "operator-plan-approval" | "full-auto-policy";
}

/**
 * Read-only operator snapshot of orchestrator state. Drawn from in-memory
 * dispatch state plus the ledger mirror; performs no I/O and is never
 * required for correctness. Consumers wrap their own rendering errors.
 */
export interface DispatchSnapshot {
	generatedAt: string;
	running: Array<{
		runId: string;
		agentId: string;
		task?: string;
		runtimeKind: string;
		outcomePhase: string;
		heartbeat: "alive" | "stale" | "dead" | "n/a";
		lineage: RunLineage;
		budget?: RunToolBudgetEnvelope;
		startedAt: string;
		/** Execution-only elapsed time retained for runtime monitoring. */
		elapsedMs: number;
		/** Routing-system phases, including total user-observed time. */
		timing?: RunPhaseDurations;
		tokens: { input: number; output: number; total: number };
		costUsd: number;
		costProvenance?: CostProvenance;
		/** Fleet node this run was placed on; null means the local node. */
		node: RunNodeIdentity | null;
	}>;
	retrying: Array<{ runId: string; agentId: string; task?: string; attempt: number; dueAt: string; reason: string }>;
	totals: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsd: number;
		/** Structural mirror of observability's CostAggregate; `calls` is what separates unpriced from priced-at-zero. */
		cost?: { knownUsd: number; hasEstimated: boolean; hasUnknown: boolean; allKnownFree: boolean; calls: number };
		runtimeSeconds: number;
	};
}

/**
 * Why a run is being aborted. Absent means an operator/user cancel. A caller
 * that time-boxes a run (dispatch `timeout_ms`) passes the timeout cause so the
 * receipt names the timeout instead of laundering it into "operator abort".
 */
export interface AbortReason {
	cause: "timeout";
	detail: string;
}

/**
 * Durable detached-batch surface. A detached dispatch's grouping and
 * collection state persist under the state dir (`batches.json`) so a barrier
 * collect works after session exit and completion nudges stay suppressed once
 * a batch is collected. Optional so lightweight contract fakes need not
 * implement it; the real dispatch extension always does.
 */
export interface DetachedBatchesContract {
	register(input: RegisterDetachedBatchInput): Promise<DetachedBatchRecord>;
	get(batchId: string): DetachedBatchRecord | null;
	list(opts?: { includeCollected?: boolean }): ReadonlyArray<DetachedBatchRecord>;
	markCollected(batchId: string): Promise<DetachedBatchRecord | null>;
}

export interface DispatchContract {
	/** True when the domain event pump publishes DispatchProgress itself. */
	readonly publishesProgress?: boolean;
	/** Whether `bus` is the same bus already owned by the domain progress pump. */
	ownsProgressBus?(bus: SafeEventBus | undefined): boolean;
	/**
	 * Resolve effective agent/target/model/node without launching or acquiring a
	 * slot. Callers pin this result into the approved request; later placement
	 * failure aborts rather than choosing a different unapproved node.
	 */
	preview?(req: DispatchRequest): DispatchPlanTaskResolution;
	/** One shared joint-resolver proposal for a typed Scout successor; never a second agent selector. */
	planAgentSelection(input: DispatchAgentPlanInput): DispatchAgentPlanResolution;
	/**
	 * Bounded, deterministic route envelope a plan may approve for this request:
	 * the resolved route first, then hard-constraint-eligible alternates. Plan
	 * approval seals this list so failover stays inside what the operator saw.
	 */
	routeCandidates?(req: DispatchRequest): ReadonlyArray<DispatchFailoverCandidate>;
	/** Durable transactional reservations prepared before a plan can be approved. */
	readonly reservations?: {
		prepare(input: {
			topology: ReservationTopology;
			tasks: ReadonlyArray<{ memberId: string; wave: number; resolution: DispatchPlanTaskResolution }>;
		}): DispatchReservationRecord;
		rollback(ownerId: string): DispatchReservationRecord | null;
		rollbackUnconsumed(ownerId: string): DispatchReservationRecord | null;
		get(ownerId: string): DispatchReservationRecord | null;
	};
	/** Session scheduling ceiling captured in the same immutable approval artifact. */
	costCeilingUsd?(): number;
	/** Current trusted hard-block state for coordinator-side merge validation. */
	protectedArtifactState?(): ProtectedArtifactState;
	/** Validate + admit + spawn a native worker. Returns run id + promise. */
	dispatch(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunReceipt>;
	}>;

	/** Spawn a group of dispatches and expose one merged batch event stream. */
	dispatchBatch(reqs: ReadonlyArray<DispatchRequest>): Promise<{
		batchId: string;
		/** Logical work ids, one per request in admission order. */
		assignmentIds: ReadonlyArray<string>;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<ReadonlyArray<RunReceipt>>;
	}>;

	/** Seal a coordinator-only council synthesis receipt without invoking a model. */
	sealCouncilSynthesis?(input: {
		group: string;
		round: number;
		kind: "none" | "vote" | "judge";
		text: string;
		subjects: ReadonlyArray<{ runId: string; digest: string | null }>;
		template: RunReceipt;
	}): Promise<RunReceipt>;

	/** List runs from the ledger. */
	listRuns(status?: RunStatus): ReadonlyArray<RunEnvelope>;

	/** Get a specific immutable attempt envelope. */
	getRun(runId: string): RunEnvelope | null;

	/**
	 * Absolute paths this run's own successful tool calls aimed a mutation at,
	 * or null when the run kept no usable record: an unknown or evicted run, a
	 * runtime that publishes no tool telemetry, telemetry that came back
	 * incomplete, or a run that called a tool able to write a path its arguments
	 * do not name. Null is not an empty list, and a caller that cannot tell them
	 * apart will read "wrote nothing" off a run nobody watched.
	 *
	 * The write boundary reads this to separate what a step changed from what
	 * changed under it, so the answer must stay a record of observation rather
	 * than an inference from the checkout.
	 */
	observedRunWrites?(runId: string): ReadonlyArray<string> | null;

	/**
	 * Full write-record witness, including durable downgrade causes. New callers
	 * use this surface; observedRunWrites remains as the closed-list compatibility
	 * view for integrations that only know paths or null.
	 */
	observedRunWriteAttribution?(runId: string): WriteBoundaryAttribution | null;

	/** In-memory logical assignment state and complete finalized-attempt history. */
	readonly assignments?: {
		/** Live assignment, including its terminal promise and detailed attempt refs. */
		get(id: AssignmentId | string): DispatchAssignment | null;
		/** Durable status/history, available after process restart. */
		getStored(id: AssignmentId | string): DurableAssignmentRecord | null;
		/**
		 * Resolve once every in-flight durable assignment write has landed. A
		 * detached caller awaits this so its assignment records exist before it
		 * returns; immediate collection then sees the assignment rather than
		 * falling back to a bare first-attempt run row.
		 */
		flushWrites?(): Promise<void>;
	};

	/**
	 * Abort a logical assignment or an individual running attempt. Assignment ids
	 * address the current attempt and suppress pending/future retries. Absent
	 * `reason` means an operator/user cancel, sealed
	 * as `outcome=canceled, outcomeDetail="operator abort"`. Pass a reason to
	 * record a non-operator cause (e.g. a dispatch `timeout_ms`) in the receipt's
	 * outcomeDetail so a time-boxed kill is distinguishable from an operator
	 * cancel; the outcome stays `canceled`.
	 */
	abort(runId: string, reason?: AbortReason): void;

	/**
	 * Queue operator guidance on a running HTTP or SDK worker. A logical
	 * assignment id addresses its current attempt. The text is sent as a JSON
	 * line on the worker's open stdin and injected into its transcript at the
	 * next loop boundary; the worker acknowledges runtime acceptance with a
	 * `clio_steer_received` event. Throws with an operator-facing message when
	 * the run is unknown or inactive, when the runtime is a single-shot
	 * subprocess or ACP delegation, or when the worker's stdin is already gone.
	 */
	steer(runId: string, text: string): void;

	/**
	 * Apply an operator's decision to a parked permission escalation on a
	 * running native worker. A logical assignment id addresses its current attempt (onPermission="escalate"). Writes a
	 * `permission_decision` JSON line on the worker's open stdin; the worker
	 * releases or denies the parked tool call and acks with a
	 * `clio_permission_resolved` event. Human-only: no model-facing tool can
	 * reach this. Throws with an operator-facing message when the run is
	 * unknown or no longer active, when the run kind has no stdin channel
	 * (acp-delegation), or when the worker's stdin is already gone. Mirrors
	 * steer's validation and error wording. Optional so lightweight contract
	 * fakes need not implement it; the real dispatch extension always does.
	 */
	resolveWorkerPermission?(runId: string, requestId: string, decision: "approve" | "deny"): void;

	/** Durable detached-batch records for async fan-out + collect. */
	detached?: DetachedBatchesContract;

	/** Read-only runtime snapshot for operator surfaces. */
	snapshot(): DispatchSnapshot;

	/** Drain active runs on shutdown (SIGTERM + grace + SIGKILL). */
	drain(): Promise<void>;
}
