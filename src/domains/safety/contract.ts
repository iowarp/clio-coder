import type { Classification, ClassifierCall } from "./action-classifier.js";
import type { DamageControlMatch } from "./damage-control.js";
import type { CompletionEvaluationInput, SafetyJudgementInput, ToolDecisionInput } from "./decision-events.js";
import type { FlowRestrictionSet, InformationFlowPolicy } from "./information-flow.js";
import type { LoopVerdict } from "./loop-detector.js";
import type { OperatorScope, SafetyPolicyDecision, SafetyPolicyMetadata } from "./policy-engine.js";
import type { RejectionMessage } from "./rejection-feedback.js";
import type { ScopeSpec } from "./scope.js";

/**
 * Posture of a re-admission the operator approved. The policy engine converts
 * its confirmation rails (damage-control ask rules, library and system-modify
 * confirmations, project confirmations) to an allow under it.
 */
export const CONFIRMED_POSTURE = "confirmed";

/**
 * Posture of a re-admission a main-agent grant approved. Distinct from
 * {@link CONFIRMED_POSTURE} on purpose: the engine clears nothing under it, so
 * every operator rail still asks and only the ordinary worker autonomy ask can
 * be discharged, by the admission evaluator (Codex review F8 and Phase B).
 */
export const MAIN_GRANT_POSTURE = "main-granted";

export type SafetyDecision =
	| { kind: "allow"; classification: Classification; policy?: SafetyPolicyDecision }
	| {
			kind: "ask";
			classification: Classification;
			confirmationRuleId?: string;
			match?: DamageControlMatch;
			rejection: RejectionMessage;
			policy?: SafetyPolicyDecision;
	  }
	| {
			kind: "block";
			classification: Classification;
			match?: DamageControlMatch;
			rejection: RejectionMessage;
			policy?: SafetyPolicyDecision;
	  };

export interface SafetyContract {
	/** Pure classification. Records nothing and emits no events. */
	classify(call: ClassifierCall): Classification;

	/**
	 * Full evaluation: classify + damage-control match + decision. Emits safety.blocked on a block; the admitting
	 * runtime records the final disposition through `decisions.recordToolCall` (#434). `scope` is present only for the main
	 * session's own calls (#419, Phase 2c) and for a worker whose permit
	 * inherited the operator's yolo (#407). At yolo the net holds only the
	 * yolo floor, operator-authored rules and the run's ceilings; at default it
	 * holds the floor, the path, authority and ceiling rails, asks for former
	 * damage-control blocks, and leaves to the main-session sandbox what a
	 * contained call's command text hides.
	 */
	evaluate(call: ClassifierCall, posture?: string, scope?: OperatorScope): SafetyDecision;

	/** Observe a call for loop detection. Returns the updated verdict. */
	observeLoop(key: string, now?: number): LoopVerdict;

	/** Read-only exposure of canonical scope specs. */
	scopes: {
		readonly readonly: ScopeSpec;
		readonly workspace: ScopeSpec;
		readonly confirmed: ScopeSpec;
	};

	/** Subset check used by dispatch admission. */
	isSubset(worker: ScopeSpec, orchestrator: ScopeSpec): boolean;

	/** Immutable safety policy metadata for run records and replay. */
	readonly policy?: {
		metadata(posture?: string): SafetyPolicyMetadata;
		/** Pure search-result filter using the same compiled policy as admission. */
		allowsObservationPath?(path: string): boolean;
		/** Block reason when a typed write would land outside the run's write roots, or null (F3). */
		writeTargetViolation?(target: string): string | null;
		/** Trust-gated information-flow rules, for evaluating a transfer against carried restrictions. */
		informationFlow?(): InformationFlowPolicy;
		/**
		 * Restrictions a tool call's result will carry, judged before it runs.
		 * Null for an unrestricted source. Any path a host opens directly for
		 * model context (a consult file, a prompt attachment) must ask the same
		 * question through `flowRestrictionsForPaths` before the bytes leave.
		 */
		flowRestrictionsFor?(call: ClassifierCall): FlowRestrictionSet | null;
		flowRestrictionsForPaths?(paths: ReadonlyArray<string>, cwd?: string): FlowRestrictionSet | null;
	};

	/**
	 * The safety domain's decisions, journaled as accountability records in the scope that decided (#434).
	 * `recordToolCall` is the registry's hook for autonomy-level final dispositions (`tool.decided`);
	 * `recordCompletionContract` is the finish contract's hook for its turn-end decision (`completion.evaluated`).
	 */
	readonly decisions: {
		recordToolCall?(input: ToolDecisionInput): void;
		recordCompletionContract?(input: CompletionEvaluationInput): void;
		/** The safety judge's hook for each review of a call that would have parked (`safety.judged`). */
		recordSafetyJudge?(input: SafetyJudgementInput): void;
	};
}
