import type { Quantity } from "../../core/telemetry/dto.js";
import { EVIDENCE_TAGS, type EvidenceTag } from "../../core/telemetry/trust-vocabulary.js";
import type { DecisionRecord } from "../session/entries.js";
import type { RunProvenanceView } from "./provenance.js";
import type { CanonicalTrustStatus, RunIntegrity } from "./trust-status.js";

export type { EvidenceTag };
export { EVIDENCE_TAGS };

/**
 * Canonical failure-cause subset for run summaries and observability histograms. Quality tags such as
 * `no-validation` remain evidence tags, but they are not failure causes.
 */
export const FAILURE_CAUSE_TAG_ORDER = [
	"timeout",
	"auth-failure",
	"missing-dependency",
	"build-failure",
	"test-failure",
	"blocked-tool",
] as const satisfies readonly EvidenceTag[];

export type FailureCauseTag = (typeof FAILURE_CAUSE_TAG_ORDER)[number];

/** Fast membership test for the canonical failure-cause subset. */
export const FAILURE_CAUSE_TAGS: ReadonlySet<EvidenceTag> = new Set(FAILURE_CAUSE_TAG_ORDER);

export type EvidenceSeverity = "info" | "warn";

export interface EvidenceFinding {
	id: string;
	severity: EvidenceSeverity;
	tag: EvidenceTag;
	runId: string;
	message: string;
}

/** A decision the run cited, as its sealed assessment recorded it when the run settled. */
export interface EvidenceDecision {
	runId: string;
	sessionId: string;
	ref: string;
	record: DecisionRecord;
}

/** A gate decision that judged the run by the time it settled. */
export interface EvidenceVerdict {
	decisionId: string;
	digest: string;
	outcome: string;
	review: CanonicalTrustStatus["independentReview"]["state"];
}

/**
 * One finished run's evidence, read from its run scope (#434): the seal's verdict, and under a verified seal the
 * assessment its producer journaled before sealing. Nothing the mutable run ledger says reaches this view.
 */
export interface RunEvidence {
	runId: string;
	sessionId: string | null;
	/** The workspace dispatch ran the run from, as its sealed assessment records it; null when it records none. */
	cwd: string | null;
	integrity: RunIntegrity;
	/** The assessment's axes with the seal's own integrity verdict; the run record's alone when not assessed. */
	trust: CanonicalTrustStatus;
	/** When the assessment was journaled; null when the run was never assessed or its seal does not verify. */
	assessedAt: string | null;
	settled: {
		at: string;
		startedAt: string;
		endedAt: string;
		agentId: string;
		targetId: string;
		runtimeId: string;
		wireModelId: string;
		outcome: string;
		exitCode: number | null;
	} | null;
	firstPassSuccess: boolean | null;
	failureCause: EvidenceTag | null;
	/** Distinct finding tags, sorted. */
	tags: EvidenceTag[];
	findings: EvidenceFinding[];
	verdicts: EvidenceVerdict[];
	/** Provenance the sealed assessment records; null when it records none. */
	provenance: RunProvenanceView | null;
	decisions: EvidenceDecision[];
	/** Claims of validation the run made without a matching command, from its settled record. */
	ungroundedClaims: number;
	/** Null unless the seal verifies: an unauthenticated record states no totals. */
	totals: {
		toolCalls: number;
		toolErrors: number;
		blockedToolCalls: number;
		/** The run's folded quantities, with their coverage: a partially measured run keeps its known subtotal. */
		tokens: Quantity;
		usd: Quantity;
		wallTimeMs: number;
	} | null;
}
