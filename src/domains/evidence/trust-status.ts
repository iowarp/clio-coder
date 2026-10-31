import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import type { RunSettled } from "../../core/telemetry/schemas.js";
import {
	TRUST_ABSENCE_REASONS,
	TRUST_ARTIFACT_KINDS,
	TRUST_STATUS_AUTHORITY_KINDS,
	TRUST_STATUS_AXES,
	TRUST_STATUS_SOURCE_KINDS,
	TRUST_STATUS_STATES,
	type TrustStatusAxis,
} from "../../core/telemetry/trust-vocabulary.js";
import { parseWorkerContextProvenance } from "../../worker/context-seed.js";
import type { GateDecisionArtifact, GateDecisionVerification } from "../dispatch/gate-decisions.js";
import type { RunBriefingProvenance, RunProjectContextProvenance, RunResult } from "../dispatch/types.js";
import { normalizeYoloGateAuthority, normalizeYoloGateOutcome } from "../dispatch/yolo-ids.js";
import type { SealVerdict } from "../telemetry/seal.js";
import { describeSealMismatch } from "../telemetry/seal.js";

/** Persisted version of the canonical, deliberately non-scalar trust model. */
export const TRUST_STATUS_VERSION = 1 as const;

/** Hard bounds keep references useful as pointers without turning them into embedded artifacts. */
export const TRUST_STATUS_MAX_ARTIFACT_REFERENCES = 16;
export const TRUST_STATUS_MAX_IDENTIFIER_LENGTH = 512;

export type { TrustStatusAxis } from "../../core/telemetry/trust-vocabulary.js";
export { TRUST_STATUS_AXES, TRUST_STATUS_STATES } from "../../core/telemetry/trust-vocabulary.js";

export type TrustStatusSourceKind = (typeof TRUST_STATUS_SOURCE_KINDS)[number];

export interface TrustStatusSource {
	kind: TrustStatusSourceKind;
	id: string;
}

export type TrustStatusAuthorityKind = (typeof TRUST_STATUS_AUTHORITY_KINDS)[number];

/** The actor or subsystem entitled to make the attributed observation. */
export interface TrustStatusAuthority {
	kind: TrustStatusAuthorityKind;
	id: string;
}

export type TrustArtifactKind = (typeof TRUST_ARTIFACT_KINDS)[number];

export interface TrustArtifactReference {
	kind: TrustArtifactKind;
	id: string;
	digest?: {
		algorithm: "sha256";
		value: string;
	};
}

/** Every observed fact, including unknown and not applicable, is attributable. */
export interface AttributedTrustStatus {
	source: TrustStatusSource;
	authority: TrustStatusAuthority;
	artifacts: ReadonlyArray<TrustArtifactReference>;
}

export type TrustAbsenceReason = (typeof TRUST_ABSENCE_REASONS)[number];

export interface AbsentTrustStatus {
	state: "absent";
	reason: TrustAbsenceReason;
}

type AttributedState<State extends string> = { state: State } & AttributedTrustStatus;

type NonAbsentAxisState<Axis extends TrustStatusAxis> = Exclude<(typeof TRUST_STATUS_STATES)[Axis][number], "absent">;

export type ArtifactIntegrityStatus = AttributedState<NonAbsentAxisState<"artifactIntegrity">> | AbsentTrustStatus;

export type ValidationGroundingStatus = AttributedState<NonAbsentAxisState<"validationGrounding">> | AbsentTrustStatus;

export type IndependentReviewStatus = AttributedState<NonAbsentAxisState<"independentReview">> | AbsentTrustStatus;

export type ContextProvenanceStatus = AttributedState<NonAbsentAxisState<"contextProvenance">> | AbsentTrustStatus;

export type CompletionEvidenceStatus = AttributedState<NonAbsentAxisState<"completionEvidence">> | AbsentTrustStatus;

export interface TrustStatusAxes {
	artifactIntegrity: ArtifactIntegrityStatus;
	validationGrounding: ValidationGroundingStatus;
	independentReview: IndependentReviewStatus;
	contextProvenance: ContextProvenanceStatus;
	completionEvidence: CompletionEvidenceStatus;
}

/**
 * One canonical aggregate. It has no confidence score or overall verdict;
 * callers consume only the axes relevant to their decision.
 */
export interface CanonicalTrustStatus extends TrustStatusAxes {
	version: typeof TRUST_STATUS_VERSION;
}

export type TrustStatusProjection = Partial<TrustStatusAxes>;

export type TrustStatusValidation = { ok: true; status: CanonicalTrustStatus } | { ok: false; reason: string };

const AXIS_STATES: Record<TrustStatusAxis, ReadonlySet<string>> = {
	artifactIntegrity: new Set(TRUST_STATUS_STATES.artifactIntegrity),
	validationGrounding: new Set(TRUST_STATUS_STATES.validationGrounding),
	independentReview: new Set(TRUST_STATUS_STATES.independentReview),
	contextProvenance: new Set(TRUST_STATUS_STATES.contextProvenance),
	completionEvidence: new Set(TRUST_STATUS_STATES.completionEvidence),
};

const AXIS_SOURCES: Record<TrustStatusAxis, ReadonlySet<TrustStatusSourceKind>> = {
	artifactIntegrity: new Set(["run_seal", "compatibility"]),
	validationGrounding: new Set(["run_record", "compatibility"]),
	independentReview: new Set(["gate_decision", "compatibility"]),
	contextProvenance: new Set(["run_record", "compatibility"]),
	completionEvidence: new Set(["finish_contract", "compatibility"]),
};

const SOURCE_AUTHORITIES: Record<TrustStatusSourceKind, ReadonlySet<TrustStatusAuthorityKind>> = {
	run_seal: new Set(["clio"]),
	run_record: new Set(["clio", "validator", "runtime", "external_system", "unknown"]),
	gate_decision: new Set(["clio", "reviewer", "operator", "unknown"]),
	finish_contract: new Set(["clio"]),
	compatibility: new Set(["clio", "unknown"]),
};

const ABSENCE_REASONS: ReadonlySet<string> = new Set(TRUST_ABSENCE_REASONS);

const SOURCE_KINDS: ReadonlySet<string> = new Set(TRUST_STATUS_SOURCE_KINDS);

const AUTHORITY_KINDS: ReadonlySet<string> = new Set(TRUST_STATUS_AUTHORITY_KINDS);

const ARTIFACT_KINDS: ReadonlySet<string> = new Set(TRUST_ARTIFACT_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
	const expected = new Set(keys);
	return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

/**
 * The identifier rule every source, authority, and artifact reference is held
 * to. Exported so derivation boundaries can drop an unusable identifier from a
 * malformed input row instead of throwing at normalization time.
 */
function isTrustStatusIdentifier(value: unknown): value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > TRUST_STATUS_MAX_IDENTIFIER_LENGTH) {
		return false;
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return false;
	}
	return true;
}

function compareArtifactReferences(left: TrustArtifactReference, right: TrustArtifactReference): number {
	const leftKey = `${left.kind}\u0000${left.id}\u0000${left.digest?.value ?? ""}`;
	const rightKey = `${right.kind}\u0000${right.id}\u0000${right.digest?.value ?? ""}`;
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function normalizeArtifactReference(value: unknown, path: string): TrustArtifactReference {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	if (!hasExactKeys(value, value.digest === undefined ? ["kind", "id"] : ["kind", "id", "digest"])) {
		throw new Error(`${path} has unknown or missing fields`);
	}
	if (typeof value.kind !== "string" || !ARTIFACT_KINDS.has(value.kind)) {
		throw new Error(`${path}.kind is invalid`);
	}
	if (!isTrustStatusIdentifier(value.id)) throw new Error(`${path}.id is invalid`);
	const reference: TrustArtifactReference = { kind: value.kind as TrustArtifactKind, id: value.id };
	if (value.digest !== undefined) {
		if (
			!isRecord(value.digest) ||
			!hasExactKeys(value.digest, ["algorithm", "value"]) ||
			value.digest.algorithm !== "sha256" ||
			typeof value.digest.value !== "string" ||
			!/^[a-f0-9]{64}$/u.test(value.digest.value)
		) {
			throw new Error(`${path}.digest is invalid`);
		}
		reference.digest = { algorithm: "sha256", value: value.digest.value };
	}
	return reference;
}

function normalizeAttributedStatus(axis: TrustStatusAxis, value: Record<string, unknown>): AttributedState<string> {
	if (!hasExactKeys(value, ["state", "source", "authority", "artifacts"])) {
		throw new Error(`${axis} has unknown or missing fields`);
	}
	if (!isRecord(value.source) || !hasExactKeys(value.source, ["kind", "id"])) {
		throw new Error(`${axis}.source is invalid`);
	}
	if (
		typeof value.source.kind !== "string" ||
		!SOURCE_KINDS.has(value.source.kind) ||
		!AXIS_SOURCES[axis].has(value.source.kind as TrustStatusSourceKind) ||
		!isTrustStatusIdentifier(value.source.id)
	) {
		throw new Error(`${axis}.source is invalid`);
	}
	if (!isRecord(value.authority) || !hasExactKeys(value.authority, ["kind", "id"])) {
		throw new Error(`${axis}.authority is invalid`);
	}
	if (
		typeof value.authority.kind !== "string" ||
		!AUTHORITY_KINDS.has(value.authority.kind) ||
		!SOURCE_AUTHORITIES[value.source.kind as TrustStatusSourceKind].has(
			value.authority.kind as TrustStatusAuthorityKind,
		) ||
		!isTrustStatusIdentifier(value.authority.id)
	) {
		throw new Error(`${axis}.authority is invalid`);
	}
	if (value.source.kind === "compatibility" && value.state !== "unknown" && value.state !== "not_applicable") {
		throw new Error(`${axis} compatibility source cannot establish ${value.state}`);
	}
	if (!Array.isArray(value.artifacts) || value.artifacts.length > TRUST_STATUS_MAX_ARTIFACT_REFERENCES) {
		throw new Error(`${axis}.artifacts exceeds the bounded reference list`);
	}
	const artifacts = value.artifacts.map((entry, index) =>
		normalizeArtifactReference(entry, `${axis}.artifacts[${index}]`),
	);
	artifacts.sort(compareArtifactReferences);
	for (let index = 1; index < artifacts.length; index += 1) {
		if (
			compareArtifactReferences(
				artifacts[index - 1] as TrustArtifactReference,
				artifacts[index] as TrustArtifactReference,
			) === 0
		) {
			throw new Error(`${axis}.artifacts contains a duplicate reference`);
		}
	}
	return {
		state: value.state as string,
		source: { kind: value.source.kind as TrustStatusSourceKind, id: value.source.id },
		authority: {
			kind: value.authority.kind as TrustStatusAuthorityKind,
			id: value.source.kind === "gate_decision" ? normalizeYoloGateAuthority(value.authority.id) : value.authority.id,
		},
		artifacts,
	};
}

function normalizeAxis(axis: TrustStatusAxis, value: unknown): TrustStatusAxes[TrustStatusAxis] {
	if (!isRecord(value) || typeof value.state !== "string" || !AXIS_STATES[axis].has(value.state)) {
		throw new Error(`${axis}.state is invalid`);
	}
	if (value.state === "absent") {
		if (
			!hasExactKeys(value, ["state", "reason"]) ||
			typeof value.reason !== "string" ||
			!ABSENCE_REASONS.has(value.reason)
		) {
			throw new Error(`${axis} absent state is invalid`);
		}
		return { state: "absent", reason: value.reason as TrustAbsenceReason };
	}
	return normalizeAttributedStatus(axis, value) as TrustStatusAxes[TrustStatusAxis];
}

/** Validate, defensively copy, and deterministically order a canonical aggregate. */
export function normalizeTrustStatus(value: unknown): CanonicalTrustStatus {
	if (!isRecord(value) || !TRUST_STATUS_AXES.every((axis) => Object.hasOwn(value, axis))) {
		throw new Error("trust status has missing fields");
	}
	if (value.version !== TRUST_STATUS_VERSION) throw new Error("trust status version is invalid");
	return {
		version: TRUST_STATUS_VERSION,
		artifactIntegrity: normalizeAxis("artifactIntegrity", value.artifactIntegrity) as ArtifactIntegrityStatus,
		validationGrounding: normalizeAxis("validationGrounding", value.validationGrounding) as ValidationGroundingStatus,
		independentReview: normalizeAxis("independentReview", value.independentReview) as IndependentReviewStatus,
		contextProvenance: normalizeAxis("contextProvenance", value.contextProvenance) as ContextProvenanceStatus,
		completionEvidence: normalizeAxis("completionEvidence", value.completionEvidence) as CompletionEvidenceStatus,
	};
}

/** Non-throwing boundary for persisted JSON and extension inputs. */
export function validateTrustStatus(value: unknown): TrustStatusValidation {
	try {
		return { ok: true, status: normalizeTrustStatus(value) };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export function absentTrustStatus(reason: TrustAbsenceReason): AbsentTrustStatus {
	return { state: "absent", reason };
}

/**
 * Compose exact axis projections. Later projections replace the same axis;
 * no state on one axis can fill or promote another axis.
 */
export function composeTrustStatus(...projections: ReadonlyArray<TrustStatusProjection>): CanonicalTrustStatus {
	const axes: TrustStatusAxes = {
		artifactIntegrity: absentTrustStatus("not_recorded"),
		validationGrounding: absentTrustStatus("not_recorded"),
		independentReview: absentTrustStatus("not_recorded"),
		contextProvenance: absentTrustStatus("not_recorded"),
		completionEvidence: absentTrustStatus("not_recorded"),
	};
	for (const projection of projections) {
		if (projection.artifactIntegrity !== undefined) axes.artifactIntegrity = projection.artifactIntegrity;
		if (projection.validationGrounding !== undefined) axes.validationGrounding = projection.validationGrounding;
		if (projection.independentReview !== undefined) axes.independentReview = projection.independentReview;
		if (projection.contextProvenance !== undefined) axes.contextProvenance = projection.contextProvenance;
		if (projection.completionEvidence !== undefined) axes.completionEvidence = projection.completionEvidence;
	}
	return normalizeTrustStatus({ version: TRUST_STATUS_VERSION, ...axes });
}

function sha256Reference(kind: TrustArtifactKind, id: string, digest: string | undefined): TrustArtifactReference {
	const reference: TrustArtifactReference = { kind, id };
	if (digest !== undefined && /^[a-f0-9]{64}$/u.test(digest)) {
		reference.digest = { algorithm: "sha256", value: digest };
	}
	return reference;
}

function attributed<State extends string>(
	state: State,
	source: TrustStatusSource,
	authority: TrustStatusAuthority,
	artifacts: ReadonlyArray<TrustArtifactReference>,
): AttributedState<State> {
	return { state, source, authority, artifacts: [...artifacts].sort(compareArtifactReferences) };
}

const DISPATCH_AUTHORITY: TrustStatusAuthority = { kind: "clio", id: "dispatch" };
const COMPATIBILITY_AUTHORITY: TrustStatusAuthority = { kind: "unknown", id: "historical-persisted-format" };

function validBriefing(briefing: RunBriefingProvenance): boolean {
	return Number.isSafeInteger(briefing.bytes) && briefing.bytes >= 0 && /^[a-f0-9]{64}$/u.test(briefing.contentHash);
}

function validBoundedProjectContext(context: RunProjectContextProvenance): boolean {
	return (
		context.tier === "bounded" &&
		Number.isSafeInteger(context.chars) &&
		(context.chars ?? -1) >= 0 &&
		typeof context.contentHash === "string" &&
		/^[a-f0-9]{64}$/u.test(context.contentHash)
	);
}

/**
 * The one structured message a `none`-tier run can still receive. The tier is
 * the CLIO-CODER.md handbook policy; the workspace-root message is sent
 * regardless of it, and the producer records the characters and hash of
 * every structured message it sent (`projectContextProvenanceFor` in the
 * dispatch extension). A none-tier block naming exactly this section, with
 * a well-formed count and hash, is therefore a consistent record of a real
 * message, not a contradiction. Anything else under a none tier cannot be
 * explained by the policy: a handbook section the policy forbids, a hash
 * with no section to hash, or a malformed count.
 */
const NONE_TIER_SECTIONS: ReadonlyArray<string> = ["workspace-root"];

function validNoneTierProjectContext(context: RunProjectContextProvenance): boolean {
	return (
		context.tier === "none" &&
		context.sections !== undefined &&
		context.sections.length === NONE_TIER_SECTIONS.length &&
		context.sections.every((section) => NONE_TIER_SECTIONS.includes(section)) &&
		Number.isSafeInteger(context.chars) &&
		(context.chars ?? -1) >= 0 &&
		typeof context.contentHash === "string" &&
		/^[a-f0-9]{64}$/u.test(context.contentHash)
	);
}

function validWorkerContext(value: unknown): boolean {
	try {
		parseWorkerContextProvenance(value);
		return true;
	} catch {
		return false;
	}
}

function gateReference(artifact: GateDecisionArtifact): TrustArtifactReference {
	return sha256Reference("gate_decision", artifact.id, artifact.integrity.digest);
}

function gateAuthority(artifact: GateDecisionArtifact): TrustStatusAuthority {
	if (artifact.outcome === "operator-confirmed") return { kind: "operator", id: "gate-confirmation" };
	if (normalizeYoloGateOutcome(artifact.outcome) === "yolo-applied") return { kind: "clio", id: "yolo-gate-policy" };
	return { kind: "reviewer", id: artifact.decider?.runId ?? "unavailable-decider" };
}

/**
 * Adapt one authenticated decision for one subject. Missing authentication is
 * unknown review, never a positive verdict inherited from artifact presence.
 */
export function adaptGateDecisionReviewStatus(
	artifact: GateDecisionArtifact | null | undefined,
	subjectRunId: string,
	verification?: GateDecisionVerification,
): IndependentReviewStatus {
	if (artifact === null || artifact === undefined) return absentTrustStatus("artifact_missing");
	const source: TrustStatusSource = { kind: "gate_decision", id: artifact.id };
	const artifacts = [gateReference(artifact)];
	const authority = gateAuthority(artifact);
	if (!artifact.subjects.some((subject) => subject.runId === subjectRunId)) return absentTrustStatus("not_recorded");
	if (verification === undefined || !verification.ok) {
		return attributed(
			"unknown",
			source,
			verification === undefined ? COMPATIBILITY_AUTHORITY : { kind: "unknown", id: "unauthenticated-gate-artifact" },
			artifacts,
		);
	}
	if (artifact.decider === undefined || artifact.correlation === undefined) {
		if (artifact.outcome === "operator-confirmed" || normalizeYoloGateOutcome(artifact.outcome) === "yolo-applied") {
			return attributed("not_applicable", source, authority, artifacts);
		}
		return attributed("inconclusive", source, authority, artifacts);
	}
	if (!artifact.correlation.independent) return attributed("not_independent", source, authority, artifacts);
	if (artifact.outcome === "pass") return attributed("passed", source, authority, artifacts);
	if (artifact.outcome === "fail") return attributed("failed", source, authority, artifacts);
	if (artifact.outcome === "winner") {
		return attributed(
			artifact.winner?.subject.runId === subjectRunId ? "passed" : "failed",
			source,
			authority,
			artifacts,
		);
	}
	return attributed("inconclusive", source, authority, artifacts);
}

function uniqueBoundedReferences(references: ReadonlyArray<TrustArtifactReference>): TrustArtifactReference[] {
	const sorted = [...references].sort(compareArtifactReferences);
	const unique = sorted.filter(
		(reference, index) =>
			index === 0 || compareArtifactReferences(sorted[index - 1] as TrustArtifactReference, reference) !== 0,
	);
	return unique.slice(0, TRUST_STATUS_MAX_ARTIFACT_REFERENCES);
}

/**
 * The facts a finished run's trust status reads: what its run.settled records, the run's id and the digest of that
 * record (#434). The producing process reads them from the settlement it built, every other reader from the run DTO.
 */
export type RunTrustFacts = Pick<
	RunSettled,
	"verification" | "quality" | "validationGrounding" | "hostVerification" | "contextProvenance" | "hashes"
> & { runId: string; digest: string | null };

/**
 * Whether a run's record may be read as evidence: verified by its scope's seal, or held by the process that settled
 * it; unsealed while its scope is open; failed when the seal does not verify.
 */
export type RunIntegrity =
	| { state: "verified"; by: "seal" | "producer" }
	| { state: "unsealed"; reason: string }
	| { state: "failed"; reason: string };

/** The integrity a run's seal verdict states (`telemetry/seal.ts`). */
function runIntegrityOfSeal(seal: SealVerdict | null): RunIntegrity {
	if (seal === null) return { state: "unsealed", reason: "run scope unreadable" };
	if (seal.status === "verified") return { state: "verified", by: "seal" };
	if (seal.status === "unsealed") return { state: "unsealed", reason: `run scope unsealed (${seal.reason})` };
	return { state: "failed", reason: `run seal failed: ${describeSealMismatch(seal.mismatch)}` };
}

function runRecordReference(facts: RunTrustFacts): TrustArtifactReference {
	return sha256Reference("run_record", facts.runId, facts.digest ?? undefined);
}

function runRecordSource(facts: RunTrustFacts): TrustStatusSource {
	return { kind: "run_record", id: facts.runId };
}

function runIntegrityStatus(facts: RunTrustFacts, integrity: RunIntegrity): ArtifactIntegrityStatus {
	const artifacts = [runRecordReference(facts)];
	const source: TrustStatusSource = { kind: "run_seal", id: facts.runId };
	if (integrity.state === "unsealed") return attributed("unknown", source, { kind: "clio", id: "run-seal" }, artifacts);
	return attributed(
		integrity.state === "verified" ? "verified" : "failed",
		source,
		{ kind: "clio", id: integrity.state === "verified" && integrity.by === "producer" ? "run-producer" : "run-seal" },
		artifacts,
	);
}

function runValidationArtifacts(facts: RunTrustFacts): TrustArtifactReference[] {
	const artifacts = [runRecordReference(facts)];
	for (const fact of facts.quality?.typedValidations ?? [])
		artifacts.push(sha256Reference("validation_result", fact.sourceId, fact.validatorDigest));
	const contract = facts.quality?.resultContract;
	if (contract) artifacts.push(sha256Reference("validation_result", contract.sourceId, contract.validatorDigest));
	return uniqueBoundedReferences(artifacts);
}

function settledQualityFails(quality: RunTrustFacts["quality"]): boolean {
	if (quality === null) return false;
	if (quality.typedValidations.some((fact) => !fact.passed)) return true;
	return quality.resultContract?.conformance === "fail" || quality.resultContract?.quality === "fail";
}

function settledQualityValidates(quality: RunTrustFacts["quality"]): boolean {
	if (quality === null) return false;
	if (quality.typedValidations.some((fact) => fact.passed)) return true;
	return quality.resultContract?.quality === "pass";
}

/** Correctness-bearing facts before the descriptive verification marker, as the run settled them. */
function runValidationStatus(facts: RunTrustFacts): ValidationGroundingStatus {
	const artifacts = runValidationArtifacts(facts);
	const source = runRecordSource(facts);
	const host = facts.hostVerification;
	const hostAuthority: TrustStatusAuthority = { kind: "validator", id: "host-verification" };
	if (host?.status === "rejected") {
		// Every failing host check also failed on the task base, so it cannot establish a failure the change caused.
		if (host.failed > 0 && host.failedOnBase === host.failed)
			return attributed("unknown", source, { kind: "validator", id: "host-verification-baseline-failed" }, artifacts);
		return attributed("failed", source, hostAuthority, artifacts);
	}
	if (host?.status === "verified") return attributed("validated", source, hostAuthority, artifacts);
	// A batch member the failure was charged away from has no validator verdict of its own.
	if (host?.status === "not_implicated") return attributed("unknown", source, hostAuthority, artifacts);
	if (settledQualityFails(facts.quality))
		return attributed("failed", source, { kind: "validator", id: "receipt-quality" }, artifacts);
	const grounding = facts.validationGrounding;
	if (
		grounding?.basis === "no-command-executed" &&
		(grounding.ungrounded.length > 0 || grounding.claimed > grounding.grounded)
	)
		return attributed("ungrounded", source, { kind: "validator", id: "command-grounding" }, artifacts);
	if (settledQualityValidates(facts.quality))
		return attributed("validated", source, { kind: "validator", id: "receipt-quality" }, artifacts);
	const verification = facts.verification;
	if (verification.state === "verified")
		return attributed("validated", source, { kind: "validator", id: verification.basis }, artifacts);
	if (verification.state === "unverified") return absentTrustStatus("not_observed");
	if (verification.state === "not_applicable")
		return attributed("not_applicable", source, DISPATCH_AUTHORITY, artifacts);
	return attributed(
		"unknown",
		source,
		verification.basis === "acp-external-unobserved"
			? { kind: "external_system", id: "acp-delegation" }
			: { kind: "unknown", id: verification.basis },
		artifacts,
	);
}

const CONTEXT_HASH_KINDS: Partial<Record<RunTrustFacts["hashes"][number]["subject"], TrustArtifactKind>> = {
	briefing: "briefing",
	"worker-context-seed": "worker_context",
	"project-context": "project_context",
};

function runContextStatus(facts: RunTrustFacts): ContextProvenanceStatus {
	const artifacts = [runRecordReference(facts)];
	for (const hash of facts.hashes) {
		const kind = CONTEXT_HASH_KINDS[hash.subject];
		if (kind !== undefined) artifacts.push(sha256Reference(kind, `${facts.runId}:${hash.field}`, hash.hash));
	}
	return attributed(
		facts.contextProvenance,
		runRecordSource(facts),
		DISPATCH_AUTHORITY,
		uniqueBoundedReferences(artifacts),
	);
}

/**
 * A finished run's trust status from its settled facts. Only an authenticated record's claims are read: a run whose
 * seal is open or failed keeps the integrity verdict and reads nothing else (#434).
 */
export function adaptRunTrustStatus(facts: RunTrustFacts | null, integrity: RunIntegrity): CanonicalTrustStatus {
	if (facts === null)
		return composeTrustStatus({
			artifactIntegrity: absentTrustStatus("artifact_missing"),
			validationGrounding: absentTrustStatus("artifact_missing"),
			contextProvenance: absentTrustStatus("artifact_missing"),
			independentReview: absentTrustStatus("artifact_missing"),
			completionEvidence: absentTrustStatus("artifact_missing"),
		});
	const authenticated = integrity.state === "verified";
	return composeTrustStatus({
		artifactIntegrity: runIntegrityStatus(facts, integrity),
		validationGrounding: authenticated ? runValidationStatus(facts) : absentTrustStatus("not_observed"),
		contextProvenance: authenticated ? runContextStatus(facts) : absentTrustStatus("not_observed"),
		independentReview: absentTrustStatus("not_recorded"),
		completionEvidence: absentTrustStatus("not_recorded"),
	});
}

/**
 * Whether the context a run was sent was recorded consistently, judged once when the run settles: run.settled keeps
 * the verdict and the hashes, never the context itself (#434).
 */
export function runContextProvenance(
	result: Pick<RunResult, "briefing" | "workerContext" | "projectContext">,
): RunSettled["contextProvenance"] {
	const briefingInvalid = result.briefing !== undefined && !validBriefing(result.briefing);
	if (briefingInvalid || (result.workerContext !== undefined && !validWorkerContext(result.workerContext)))
		return "invalid";
	const context = result.projectContext;
	const sentContext = result.briefing !== undefined || result.workerContext !== undefined;
	if (context === undefined) return sentContext ? "recorded" : "unknown";
	if (context.tier === "none") {
		if (context.chars === undefined && context.contentHash === undefined && context.sections === undefined)
			return sentContext ? "recorded" : "not_applicable";
		return validNoneTierProjectContext(context) ? "recorded" : "invalid";
	}
	return validBoundedProjectContext(context) ? "recorded" : "invalid";
}

export interface RunTrustInspection {
	integrity: RunIntegrity;
	status: CanonicalTrustStatus;
}

/**
 * A persisted run's trust, from the read model's run DTO: its settled facts and its seal verdict. A scope whose seal
 * fails is failed integrity even when the damage hides its run.settled from the journal reader (#434).
 */
export function inspectRunTrustStatus(
	record: Pick<RunTelemetryV1, "row" | "settled" | "seal"> | null,
): RunTrustInspection {
	if (record === null || record.settled === null) {
		if (record?.seal?.status === "failed") {
			const integrity = runIntegrityOfSeal(record.seal);
			const unread = absentTrustStatus("not_observed");
			return {
				integrity,
				status: composeTrustStatus({
					artifactIntegrity: attributed(
						"failed",
						{ kind: "run_seal", id: record.row.runId },
						{ kind: "clio", id: "run-seal" },
						[{ kind: "run_record", id: record.row.runId }],
					),
					validationGrounding: unread,
					contextProvenance: unread,
					independentReview: absentTrustStatus("not_recorded"),
					completionEvidence: absentTrustStatus("not_recorded"),
				}),
			};
		}
		const integrity: RunIntegrity = { state: "unsealed", reason: "the run has not settled" };
		return { integrity, status: adaptRunTrustStatus(null, integrity) };
	}
	const integrity = runIntegrityOfSeal(record.seal);
	return {
		integrity,
		status: adaptRunTrustStatus({ ...record.settled, runId: record.row.runId, digest: record.settled.digest }, integrity),
	};
}
