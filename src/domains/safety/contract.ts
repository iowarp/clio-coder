import type { Classification, ClassifierCall } from "./action-classifier.js";
import type { DamageControlMatch } from "./damage-control.js";
import type { LoopVerdict } from "./loop-detector.js";
import type { RejectionMessage } from "./rejection-feedback.js";
import type { ScopeSpec } from "./scope.js";

export type SafetyDecision =
	| { kind: "allow"; classification: Classification }
	| { kind: "block"; classification: Classification; match?: DamageControlMatch; rejection: RejectionMessage };

export interface SafetyContract {
	/** Pure classification. Does not write audit or emit bus events. */
	classify(call: ClassifierCall): Classification;

	/**
	 * Full evaluation: classify + damage-control match + decision. Writes an
	 * audit record AND emits on safety.classified + (safety.allowed | safety.blocked).
	 * `mode` is optional context carried into the audit entry.
	 */
	evaluate(call: ClassifierCall, mode?: string): SafetyDecision;

	/** Observe a call for loop detection. Returns the updated verdict. */
	observeLoop(key: string, now?: number): LoopVerdict;

	/** Read-only exposure of canonical scope specs. */
	scopes: { readonly default: ScopeSpec; readonly readonly: ScopeSpec; readonly super: ScopeSpec };

	/** Subset check used by dispatch admission (Phase 6). */
	isSubset(worker: ScopeSpec, orchestrator: ScopeSpec): boolean;

	/** Exposed only so diag scripts can read the last N records. Not for domain consumption. */
	readonly audit: { recordCount(): number };
}
