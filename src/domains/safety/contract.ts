import type { Classification, ClassifierCall } from "./action-classifier.js";
import type { CompletionContractAuditInput, ToolCallAuditInput } from "./audit.js";
import type { DamageControlMatch } from "./damage-control.js";
import type { LoopVerdict } from "./loop-detector.js";
import type { SafetyPolicyDecision, SafetyPolicyMetadata } from "./policy-engine.js";
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
	/** Pure classification. Does not write audit or emit bus events. */
	classify(call: ClassifierCall): Classification;

	/**
	 * Full evaluation: classify + damage-control match + decision. Writes the
	 * safety-net audit row and emits safety.blocked on a block. Registry admission writes any final autonomy disposition
	 * through `audit.recordToolCall`.
	 */
	evaluate(call: ClassifierCall, posture?: string): SafetyDecision;

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

	/** Immutable safety policy metadata for receipts, audit, and replay. */
	readonly policy?: {
		metadata(posture?: string): SafetyPolicyMetadata;
		/** Pure search-result filter using the same compiled policy as admission. */
		allowsObservationPath?(path: string): boolean;
		/** Block reason when a typed write would land outside the run's write roots, or null (F3). */
		writeTargetViolation?(target: string): string | null;
	};

	/**
	 * Shared audit sink. `recordCount` is for diagnostics; `recordToolCall` is
	 * the registry's hook for autonomy-level final dispositions;
	 * `recordCompletionContract` is the finish-contract's hook for its turn_end
	 * decision so every gate outcome is replayable from the ledger.
	 */
	readonly audit: {
		recordCount(): number;
		recordToolCall?(input: ToolCallAuditInput): void;
		recordCompletionContract?(input: CompletionContractAuditInput): void;
	};
}
