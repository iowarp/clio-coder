/**
 * The live budget view: one immutable projection of what the next provider
 * request will cost, plus the single opaque revision every consumer quotes.
 *
 * `ContextSnapshot` keeps its existing job, a capture written to the diagnostic
 * ledger. It can lag the live agent state by a whole tool batch, so it is not
 * the authority a tool, the footer, or an admission check should budget
 * against. The producer here owns that authority: the interactive adapter
 * refreshes it at the seams that actually change the next request, and every
 * consumer reads the published view instead of repricing the conversation.
 *
 * This module is pure policy plus a publication cache. It performs no I/O,
 * issues no model call, and triggers no reduction. The adapter supplies every
 * fact, including the real output reserve it will ask the provider for and a
 * fingerprint of the exact material it measured, because only the adapter can
 * see the live agent state.
 *
 * Revisions are monotonic rather than a bare content hash. A conversation that
 * returns to an earlier byte-identical state is still a later observation, and
 * an initial capture, a reconciliation, and tool growth must never alias onto
 * one revision. A publish whose material inputs did not move keeps its
 * revision, so repeated reads are stable.
 */

import { createHash } from "node:crypto";
import {
	type AdvisoryDecision,
	type AdvisoryMemory,
	DEFAULT_REDUCE_THRESHOLD,
	DEFAULT_WORKING_SET_TARGET,
	evaluatePressure,
	INITIAL_ADVISORY_MEMORY,
	type PolicyRejection,
	type PressureDecision,
	type PressureFacts,
	type PressurePhase,
	type ReductionAvailability,
	type RequestAdmission,
	type ResolvedPressurePolicy,
	resolvePressurePolicy,
} from "./pressure.js";

/** Structural split of the prompt side, in the terms the estimator produces. */
export interface LiveBudgetBreakdown {
	systemPromptTokens: number;
	messageTokens: number;
	pendingUserTokens: number;
	toolSchemaTokens: number;
}

/**
 * Where `inputTokens` came from.
 *
 * `anchored-plus-estimated-tail` is deliberately not called exact: it is a
 * provider count for the messages one attested call covered plus a chars/4
 * estimate of everything appended since. `historical` is a persisted
 * measurement read before this process built a runtime; it describes the
 * conversation the previous process measured, not the next request.
 */
export type LiveBudgetInputSource = "estimated" | "anchored-plus-estimated-tail" | "historical" | "unknown";

/** Whether the structural split was recomputed live or read off a capture. */
export type LiveBudgetBreakdownSource = "live" | "captured";

/** The last reduction this session performed, as the producer was told about it. */
export interface LiveBudgetReductionProjection {
	stage: string;
	tokensBefore: number;
	tokensAfter: number;
	trigger: string;
}

/**
 * Optional continuity projections. Packet 02 owns the durable records these
 * describe; the producer only carries whatever an injected reader hands it, so
 * this slice implements no persistence and requires no packet 02 record shape.
 */
export interface LiveBudgetHandoffProjection {
	id: string;
	preparedAt: string | null;
	/** The live revision the note was prepared against, when one was recorded. */
	sourceRevision: string | null;
}

export interface LiveBudgetOutcomeProjection {
	outcome: string;
	at: string | null;
	detail: string | null;
}

export interface LiveBudgetView {
	/** Opaque and monotonic. Compare for equality; never parse. */
	revision: string;
	/** Diagnostic cross-reference to the persisted capture, never the live authority. */
	capturedSnapshotId: string | null;
	sessionId: string | null;
	/**
	 * Advisory branch identity. Stable while a branch's leaf advances through
	 * ordinary appends; it moves only on real branch navigation, so an advisory
	 * announced once is not announced again after every tool batch.
	 */
	branchAnchorTurnId: string | null;
	/** Ledger leaf the next append parents under. Diagnostic; never the advisory anchor. */
	activeLeafTurnId: string | null;
	activeUserTurnId: string | null;
	targetId: string | null;
	runtimeId: string | null;
	modelId: string | null;
	modelApi: string | null;
	effectiveWindow: number | null;
	windowSource: string | null;
	/** Structural chars/4 projection of the next request's prompt side. */
	estimatedInputTokens: number | null;
	/** Provider-attested prefix plus an estimated tail, or null when no anchor holds. */
	anchoredInputTokens: number | null;
	/** The figure to budget against: the higher of the two above. */
	inputTokens: number | null;
	inputSource: LiveBudgetInputSource;
	/** True when the figures describe a persisted capture rather than a live runtime. */
	historical: boolean;
	breakdown: LiveBudgetBreakdown | null;
	breakdownSource: LiveBudgetBreakdownSource | null;
	/** Preflight output reservation for the next request; null when unresolvable. */
	outputReserveTokens: number | null;
	/**
	 * Compaction-threshold headroom recorded by the capture. It is not the output
	 * reserve and must never be presented as one.
	 */
	thresholdReserveTokens: number | null;
	headroomTokens: number | null;
	pressure: number | null;
	phase: PressurePhase;
	admission: RequestAdmission;
	advisory: AdvisoryDecision;
	/** The policy actually in force for this view. */
	policy: ResolvedPressurePolicy;
	/**
	 * Why the configured threshold/target pair was refused, or null when
	 * `policy` is the configured one. Non-null means the defaults are running
	 * and the operator's configuration is not.
	 */
	policyRejection: PolicyRejection | null;
	reduction: ReductionAvailability;
	lastReduction: LiveBudgetReductionProjection | null;
	pendingHandoff: LiveBudgetHandoffProjection | null;
	lastOutcome: LiveBudgetOutcomeProjection | null;
}

/**
 * Everything the producer needs for one publication.
 *
 * `reductionBasisKey` is the adapter's exact identity for the request a
 * reduction would be asked about. It is computed after the live estimate and
 * the output reservation are resolved, so it covers the measured content, the
 * route and its resolved output cap, the reconciled accounting, and the
 * settings that decide reduction eligibility. It deliberately excludes the
 * `reduction` verdict itself, which would otherwise change its own key. It is
 * not the advisory identity: an advisory re-arms on a different budget basis,
 * while a refusal survives only for one byte-identical request.
 */
export interface LiveBudgetInput {
	sessionId: string | null;
	branchAnchorTurnId: string | null;
	activeLeafTurnId: string | null;
	activeUserTurnId: string | null;
	capturedSnapshotId: string | null;
	targetId: string | null;
	runtimeId: string | null;
	modelId: string | null;
	modelApi: string | null;
	effectiveWindow: number | null;
	windowSource: string | null;
	estimatedInputTokens: number | null;
	anchoredInputTokens: number | null;
	inputTokens: number | null;
	inputSource: LiveBudgetInputSource;
	historical: boolean;
	breakdown: LiveBudgetBreakdown | null;
	breakdownSource: LiveBudgetBreakdownSource | null;
	outputReserveTokens: number | null;
	thresholdReserveTokens: number | null;
	policy: ResolvedPressurePolicy;
	policyRejection: PolicyRejection | null;
	reduction: ReductionAvailability;
	/** Post-accounting request identity; see the interface comment. */
	reductionBasisKey: string;
	/** System-prompt identity for advisory re-arming. */
	promptFingerprint: string | null;
	/** Tool-surface identity for advisory re-arming. */
	toolSignature: string | null;
	/** Incremented by real branch navigation only, never by an ordinary append. */
	navigationEpoch: number;
	lastReduction: LiveBudgetReductionProjection | null;
	pendingHandoff: LiveBudgetHandoffProjection | null;
	lastOutcome: LiveBudgetOutcomeProjection | null;
}

export interface LiveBudgetProducer {
	/**
	 * Recompute and cache the view. The only thing this mutates is that cache.
	 * Republishing unchanged facts keeps the revision and the advisory verdict
	 * that revision was given, so a refresh can never consume a crossing.
	 */
	publish(input: LiveBudgetInput): LiveBudgetView;
	/** Last published view, or null before the first publication. Pure. */
	current(): LiveBudgetView | null;
	/** Drop the cache and the advisory memory on a session switch. */
	reset(): void;
}

export interface LiveBudgetPolicyResolution {
	policy: ResolvedPressurePolicy;
	/**
	 * Why the configured pair was refused, or null when it is the policy in
	 * force. A refusal is reported, never repaired into a fabricated setting the
	 * operator never wrote: the defaults take over and say so.
	 */
	rejection: PolicyRejection | null;
}

/**
 * Resolve the pressure policy from the two existing, independent settings:
 * `context.compaction.threshold` is the reduce point and
 * `context.workingSet.target` is the working-set target an applied eviction
 * batches down to. The target is not derived from the threshold; a session
 * configured at 0.9 / 0.6 publishes exactly 0.9 and 0.6.
 *
 * Either value left unset falls through to the product default. A pair
 * `resolvePressurePolicy` refuses (out of range, or a target at or above its own
 * reduce point) yields the default policy plus the refusal reason, so the view
 * can state that the configured policy is not the one in force.
 */
export function resolveLiveBudgetPolicy(
	reduceThreshold: number | null | undefined,
	workingSetTarget: number | null | undefined,
): LiveBudgetPolicyResolution {
	const configured = resolvePressurePolicy({
		...(typeof reduceThreshold === "number" ? { reduceThreshold } : {}),
		...(typeof workingSetTarget === "number" ? { workingSetTarget } : {}),
	});
	if (configured.ok) return { policy: configured.policy, rejection: null };
	const fallback = resolvePressurePolicy({
		reduceThreshold: DEFAULT_REDUCE_THRESHOLD,
		workingSetTarget: DEFAULT_WORKING_SET_TARGET,
	});
	/* c8 ignore next */
	if (!fallback.ok) throw new Error(`default pressure policy is unresolvable: ${fallback.reason}`);
	return { policy: fallback.policy, rejection: configured.reason };
}

/**
 * Everything whose change makes this a different published view, the optional
 * projections included: a consumer quoting a revision must not find different
 * continuity values under it later. Deliberately excludes `capturedSnapshotId`
 * (a diagnostic id that moves on every capture) and the advancing ledger leaf,
 * so the revision tracks the request rather than the bookkeeping around it.
 */
function materialFingerprint(input: LiveBudgetInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"live-budget/1",
				input.sessionId,
				input.branchAnchorTurnId,
				input.navigationEpoch,
				input.targetId,
				input.runtimeId,
				input.modelId,
				input.modelApi,
				input.effectiveWindow,
				input.windowSource,
				input.estimatedInputTokens,
				input.anchoredInputTokens,
				input.inputTokens,
				input.inputSource,
				input.historical,
				input.breakdown,
				input.breakdownSource,
				input.outputReserveTokens,
				input.thresholdReserveTokens,
				input.policy.notice,
				input.policy.prepare,
				input.policy.reduce,
				input.policy.target,
				input.policyRejection,
				input.reduction,
				input.reductionBasisKey,
				input.promptFingerprint,
				input.toolSignature,
				input.lastReduction,
				input.pendingHandoff,
				input.lastOutcome,
			]),
		)
		.digest("hex");
}

/**
 * A reserve the adapter could not resolve is unknown, not zero. `evaluatePressure`
 * reports any non-finite measurement as unknown rather than admitting a request
 * it never priced, which is exactly the verdict a view without a runtime
 * deserves. The policy labels that case `input-unknown`; the view says which
 * measurement was missing by leaving that field null.
 */
function pressureFacts(input: LiveBudgetInput): PressureFacts {
	return {
		revision: {
			sessionId: input.sessionId ?? "",
			branchAnchorTurnId: input.branchAnchorTurnId,
			// The policy reuses a no-cut refusal only for this exact identity, so
			// it has to be the post-accounting one: a recalibrated anchor or a
			// different resolved output cap is a request the reducer never saw.
			revisionId: input.reductionBasisKey,
		},
		inputTokens: input.inputTokens,
		inputSource: input.inputSource === "anchored-plus-estimated-tail" ? "trusted" : "estimated",
		effectiveContextWindow: input.effectiveWindow,
		outputReserveTokens: input.outputReserveTokens ?? Number.NaN,
		// The live estimate already prices pending text, tool schemas, and every
		// injected block, so there is nothing left for the caller to add once.
		pendingRequestOverheadTokens: 0,
		reduction: input.reduction,
		contextIdentity: {
			targetId: input.targetId,
			modelId: input.modelId,
			promptFingerprint: input.promptFingerprint,
			toolSignature: input.toolSignature,
			epoch: input.navigationEpoch,
		},
	};
}

/** Copy and freeze a flat value object so a publication cannot be edited behind a quoted revision. */
function frozenCopy<T extends object>(value: T | null): T | null {
	return value === null ? null : Object.freeze({ ...value });
}

export function createLiveBudgetProducer(): LiveBudgetProducer {
	let view: LiveBudgetView | null = null;
	let fingerprint: string | null = null;
	let sequence = 0;
	let memory: AdvisoryMemory = INITIAL_ADVISORY_MEMORY;
	let decision: PressureDecision | null = null;

	return {
		publish(input: LiveBudgetInput): LiveBudgetView {
			const next = materialFingerprint(input);
			const transitioned = next !== fingerprint;
			if (transitioned) {
				fingerprint = next;
				sequence += 1;
			}
			const revision = `lb-${sequence}-${next.slice(0, 16)}`;
			// The advisory is evaluated once per material transition and then held.
			// A refresh that changes nothing must not consume a crossing: republishing
			// identical facts would otherwise turn `emit` from true to false under a
			// revision a consumer has not read yet. One-time delivery deduplicates on
			// `revision`; nothing here treats a cache refresh as acknowledgement.
			//
			// An unmeasured decision already reports null pressure and headroom and
			// carries the prior advisory memory through untouched, so nothing here
			// has to special-case a view without a runtime.
			if (transitioned || decision === null) {
				decision = evaluatePressure(pressureFacts(input), input.policy, memory);
				memory = decision.memory;
			}
			view = Object.freeze({
				revision,
				capturedSnapshotId: input.capturedSnapshotId,
				sessionId: input.sessionId,
				branchAnchorTurnId: input.branchAnchorTurnId,
				activeLeafTurnId: input.activeLeafTurnId,
				activeUserTurnId: input.activeUserTurnId,
				targetId: input.targetId,
				runtimeId: input.runtimeId,
				modelId: input.modelId,
				modelApi: input.modelApi,
				effectiveWindow: input.effectiveWindow,
				windowSource: input.windowSource,
				estimatedInputTokens: input.estimatedInputTokens,
				anchoredInputTokens: input.anchoredInputTokens,
				inputTokens: input.inputTokens,
				inputSource: input.inputSource,
				historical: input.historical,
				breakdown: frozenCopy(input.breakdown),
				breakdownSource: input.breakdownSource,
				outputReserveTokens: input.outputReserveTokens,
				thresholdReserveTokens: input.thresholdReserveTokens,
				headroomTokens: decision.headroomTokens,
				pressure: decision.pressure,
				phase: decision.phase,
				admission: decision.admission,
				advisory: decision.advisory,
				policy: Object.freeze({ ...input.policy }),
				policyRejection: input.policyRejection,
				reduction: input.reduction,
				// Copied and frozen at this boundary. An injected reader owns the
				// object it returns and may reuse or mutate it; a published view is
				// the thing a revision names, and it does not change underneath one.
				lastReduction: frozenCopy(input.lastReduction),
				pendingHandoff: frozenCopy(input.pendingHandoff),
				lastOutcome: frozenCopy(input.lastOutcome),
			});
			return view;
		},

		current(): LiveBudgetView | null {
			return view;
		},

		reset(): void {
			view = null;
			fingerprint = null;
			decision = null;
			memory = INITIAL_ADVISORY_MEMORY;
		},
	};
}
