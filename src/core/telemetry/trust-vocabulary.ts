/**
 * The closed vocabularies a run's assessment is written in: its trust axes and their states, who may attribute them,
 * and the finding tags. Free of schema imports, so the evidence domain and the journal schema share one list (#434).
 */

export const TRUST_STATUS_AXES = [
	"artifactIntegrity",
	"validationGrounding",
	"independentReview",
	"contextProvenance",
	"completionEvidence",
] as const;

export type TrustStatusAxis = (typeof TRUST_STATUS_AXES)[number];

export const TRUST_STATUS_STATES = {
	artifactIntegrity: ["verified", "failed", "absent", "unknown", "not_applicable"],
	validationGrounding: ["validated", "failed", "ungrounded", "absent", "unknown", "not_applicable"],
	independentReview: ["passed", "failed", "inconclusive", "not_independent", "absent", "unknown", "not_applicable"],
	contextProvenance: ["recorded", "invalid", "absent", "unknown", "not_applicable"],
	completionEvidence: ["evidenced", "incomplete", "limited", "absent", "unknown", "not_applicable"],
} as const satisfies Record<TrustStatusAxis, ReadonlyArray<string>>;

export const TRUST_STATUS_SOURCE_KINDS = [
	"run_seal",
	"run_record",
	"gate_decision",
	"finish_contract",
	"compatibility",
] as const;

export const TRUST_STATUS_AUTHORITY_KINDS = [
	"clio",
	"validator",
	"reviewer",
	"operator",
	"runtime",
	"external_system",
	"unknown",
] as const;

export const TRUST_ARTIFACT_KINDS = [
	"run_record",
	"validation_result",
	"gate_decision",
	"briefing",
	"project_context",
	"worker_context",
	"autonomy_policy",
	"finish_contract_evidence",
	"session_entry",
] as const;

export const TRUST_ABSENCE_REASONS = ["not_recorded", "not_observed", "artifact_missing", "historical_format"] as const;

export const EVIDENCE_TAGS = [
	"timeout",
	"context-overflow",
	"provider-transient",
	"missing-dependency",
	"wrong-runtime",
	"proxy-validation",
	"no-validation",
	"destructive-cleanup",
	"blocked-tool",
	"escalation",
	"external-bypass",
	"external-approximation",
	"independent-review",
	"context-provenance",
	"completion-evidence",
	"run-seal",
	"protected-artifact",
	"tool-loop",
	"test-failure",
	"build-failure",
	"auth-failure",
	"unknown",
] as const;

export type EvidenceTag = (typeof EVIDENCE_TAGS)[number];
