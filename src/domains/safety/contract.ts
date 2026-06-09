import type { Classification, ClassifierCall } from "./action-classifier.js";
import type { DamageControlMatch } from "./damage-control.js";
import type { LoopVerdict } from "./loop-detector.js";
import type { SafetyPolicyDecision, SafetyPolicyMetadata } from "./policy-engine.js";
import type { RejectionMessage } from "./rejection-feedback.js";
import type { ScopeSpec } from "./scope.js";

export type SafetyDecision =
	| { kind: "allow"; classification: Classification; policy?: SafetyPolicyDecision }
	| {
			kind: "ask";
			classification: Classification;
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
	 * Full evaluation: classify + damage-control match + decision. Writes an
	 * audit record AND emits on safety.classified + (safety.allowed | safety.blocked).
	 * `posture` is optional context carried into the audit entry.
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

	/** Subset check used by dispatch admission (Phase 6). */
	isSubset(worker: ScopeSpec, orchestrator: ScopeSpec): boolean;

	/** Immutable safety policy metadata for receipts, audit, and replay. */
	readonly policy?: { metadata(posture?: string): SafetyPolicyMetadata };

	/** Exposed only so diag scripts can read the last N records. Not for domain consumption. */
	readonly audit: { recordCount(): number };
}
