import type { GateDecisionArtifact, GateDecisionVerification } from "../dispatch/gate-decisions.js";
import { RUN_RECEIPT_INTEGRITY_VERSION, verifyReceiptIntegrity } from "../dispatch/receipt-integrity.js";
import type {
	RunBriefingProvenance,
	RunEnvelope,
	RunProjectContextProvenance,
	RunReceipt,
	RunReceiptQuality,
	RunReceiptVerification,
} from "../dispatch/types.js";
import type { FinishContractAssessment } from "../safety/finish-contract.js";

/** Persisted version of the canonical, deliberately non-scalar trust model. */
export const TRUST_STATUS_VERSION = 1 as const;

/** Hard bounds keep references useful as pointers without turning them into embedded artifacts. */
export const TRUST_STATUS_MAX_ARTIFACT_REFERENCES = 16;
export const TRUST_STATUS_MAX_IDENTIFIER_LENGTH = 512;

export const TRUST_STATUS_AXES = [
	"artifactIntegrity",
	"validationGrounding",
	"independentReview",
	"contextProvenance",
	"autonomyEnforcement",
	"completionEvidence",
] as const;

export type TrustStatusAxis = (typeof TRUST_STATUS_AXES)[number];

/** Runtime vocabularies and the source of the corresponding closed state unions. */
export const TRUST_STATUS_STATES = {
	artifactIntegrity: ["verified", "failed", "absent", "unknown", "not_applicable"],
	validationGrounding: ["validated", "failed", "ungrounded", "absent", "unknown", "not_applicable"],
	independentReview: ["passed", "failed", "inconclusive", "not_independent", "absent", "unknown", "not_applicable"],
	contextProvenance: ["recorded", "invalid", "absent", "unknown", "not_applicable"],
	autonomyEnforcement: ["enforced", "approximated", "bypassed", "absent", "unknown", "not_applicable"],
	completionEvidence: ["evidenced", "incomplete", "limited", "absent", "unknown", "not_applicable"],
} as const satisfies Record<TrustStatusAxis, ReadonlyArray<string>>;

export type TrustStatusSourceKind =
	| "receipt_integrity_verification"
	| "run_receipt"
	| "gate_decision"
	| "evidence_bundle"
	| "finish_contract"
	| "compatibility";

export interface TrustStatusSource {
	kind: TrustStatusSourceKind;
	id: string;
}

export type TrustStatusAuthorityKind =
	| "clio"
	| "validator"
	| "reviewer"
	| "operator"
	| "runtime"
	| "external_system"
	| "unknown";

/** The actor or subsystem entitled to make the attributed observation. */
export interface TrustStatusAuthority {
	kind: TrustStatusAuthorityKind;
	id: string;
}

export type TrustArtifactKind =
	| "run_receipt"
	| "validation_result"
	| "gate_decision"
	| "briefing"
	| "project_context"
	| "autonomy_policy"
	| "finish_contract_evidence"
	| "evidence_bundle"
	| "session_entry";

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

export type TrustAbsenceReason = "not_recorded" | "not_observed" | "artifact_missing" | "historical_format";

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

export type AutonomyEnforcementStatus = AttributedState<NonAbsentAxisState<"autonomyEnforcement">> | AbsentTrustStatus;

export type CompletionEvidenceStatus = AttributedState<NonAbsentAxisState<"completionEvidence">> | AbsentTrustStatus;

export interface TrustStatusAxes {
	artifactIntegrity: ArtifactIntegrityStatus;
	validationGrounding: ValidationGroundingStatus;
	independentReview: IndependentReviewStatus;
	contextProvenance: ContextProvenanceStatus;
	autonomyEnforcement: AutonomyEnforcementStatus;
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

/**
 * Artifact kinds that are self-reports of the run under inspection. They can
 * establish `completionEvidence`, the axis they authentically own, and can
 * never be read as independently observed validation.
 */
const SELF_REPORTED_ARTIFACT_KINDS: ReadonlySet<TrustArtifactKind> = new Set([
	"finish_contract_evidence",
	"run_receipt",
]);

const AXIS_STATES: Record<TrustStatusAxis, ReadonlySet<string>> = {
	artifactIntegrity: new Set(TRUST_STATUS_STATES.artifactIntegrity),
	validationGrounding: new Set(TRUST_STATUS_STATES.validationGrounding),
	independentReview: new Set(TRUST_STATUS_STATES.independentReview),
	contextProvenance: new Set(TRUST_STATUS_STATES.contextProvenance),
	autonomyEnforcement: new Set(TRUST_STATUS_STATES.autonomyEnforcement),
	completionEvidence: new Set(TRUST_STATUS_STATES.completionEvidence),
};

const AXIS_SOURCES: Record<TrustStatusAxis, ReadonlySet<TrustStatusSourceKind>> = {
	artifactIntegrity: new Set(["receipt_integrity_verification", "compatibility"]),
	validationGrounding: new Set(["run_receipt", "evidence_bundle", "compatibility"]),
	independentReview: new Set(["gate_decision", "compatibility"]),
	contextProvenance: new Set(["run_receipt", "evidence_bundle", "compatibility"]),
	autonomyEnforcement: new Set(["run_receipt", "compatibility"]),
	completionEvidence: new Set(["finish_contract", "compatibility"]),
};

const SOURCE_AUTHORITIES: Record<TrustStatusSourceKind, ReadonlySet<TrustStatusAuthorityKind>> = {
	receipt_integrity_verification: new Set(["clio"]),
	run_receipt: new Set(["clio", "validator", "runtime", "external_system", "unknown"]),
	gate_decision: new Set(["clio", "reviewer", "operator", "unknown"]),
	evidence_bundle: new Set(["clio"]),
	finish_contract: new Set(["clio"]),
	compatibility: new Set(["clio", "unknown"]),
};

const ABSENCE_REASONS: ReadonlySet<string> = new Set([
	"not_recorded",
	"not_observed",
	"artifact_missing",
	"historical_format",
]);

const SOURCE_KINDS: ReadonlySet<string> = new Set([
	"receipt_integrity_verification",
	"run_receipt",
	"gate_decision",
	"evidence_bundle",
	"finish_contract",
	"compatibility",
]);

const AUTHORITY_KINDS: ReadonlySet<string> = new Set([
	"clio",
	"validator",
	"reviewer",
	"operator",
	"runtime",
	"external_system",
	"unknown",
]);

const ARTIFACT_KINDS: ReadonlySet<string> = new Set([
	"run_receipt",
	"validation_result",
	"gate_decision",
	"briefing",
	"project_context",
	"autonomy_policy",
	"finish_contract_evidence",
	"evidence_bundle",
	"session_entry",
]);

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
export function isTrustStatusIdentifier(value: unknown): value is string {
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
		authority: { kind: value.authority.kind as TrustStatusAuthorityKind, id: value.authority.id },
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
	if (!isRecord(value) || !hasExactKeys(value, ["version", ...TRUST_STATUS_AXES])) {
		throw new Error("trust status has unknown or missing fields");
	}
	if (value.version !== TRUST_STATUS_VERSION) throw new Error("trust status version is invalid");
	return {
		version: TRUST_STATUS_VERSION,
		artifactIntegrity: normalizeAxis("artifactIntegrity", value.artifactIntegrity) as ArtifactIntegrityStatus,
		validationGrounding: normalizeAxis("validationGrounding", value.validationGrounding) as ValidationGroundingStatus,
		independentReview: normalizeAxis("independentReview", value.independentReview) as IndependentReviewStatus,
		contextProvenance: normalizeAxis("contextProvenance", value.contextProvenance) as ContextProvenanceStatus,
		autonomyEnforcement: normalizeAxis("autonomyEnforcement", value.autonomyEnforcement) as AutonomyEnforcementStatus,
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
		autonomyEnforcement: absentTrustStatus("not_recorded"),
		completionEvidence: absentTrustStatus("not_recorded"),
	};
	for (const projection of projections) {
		if (projection.artifactIntegrity !== undefined) axes.artifactIntegrity = projection.artifactIntegrity;
		if (projection.validationGrounding !== undefined) axes.validationGrounding = projection.validationGrounding;
		if (projection.independentReview !== undefined) axes.independentReview = projection.independentReview;
		if (projection.contextProvenance !== undefined) axes.contextProvenance = projection.contextProvenance;
		if (projection.autonomyEnforcement !== undefined) axes.autonomyEnforcement = projection.autonomyEnforcement;
		if (projection.completionEvidence !== undefined) axes.completionEvidence = projection.completionEvidence;
	}
	return normalizeTrustStatus({ version: TRUST_STATUS_VERSION, ...axes });
}

/** Project only explicitly requested axes and preserve their exact states. */
export function projectTrustStatus(
	status: CanonicalTrustStatus,
	axes: ReadonlyArray<TrustStatusAxis>,
): TrustStatusProjection {
	const normalized = normalizeTrustStatus(status);
	const projection: TrustStatusProjection = {};
	const requested = new Set(axes);
	if (requested.has("artifactIntegrity")) projection.artifactIntegrity = normalized.artifactIntegrity;
	if (requested.has("validationGrounding")) projection.validationGrounding = normalized.validationGrounding;
	if (requested.has("independentReview")) projection.independentReview = normalized.independentReview;
	if (requested.has("contextProvenance")) projection.contextProvenance = normalized.contextProvenance;
	if (requested.has("autonomyEnforcement")) projection.autonomyEnforcement = normalized.autonomyEnforcement;
	if (requested.has("completionEvidence")) projection.completionEvidence = normalized.completionEvidence;
	return projection;
}

export type PersistedRunReceiptTrustFacts = Pick<RunReceipt, "runId"> &
	Partial<
		Pick<
			RunReceipt,
			| "integrity"
			| "verification"
			| "hostVerification"
			| "quality"
			| "validationGrounding"
			| "briefing"
			| "projectContext"
			| "autonomyEnforcement"
		>
	>;

function sha256Reference(kind: TrustArtifactKind, id: string, digest: string | undefined): TrustArtifactReference {
	const reference: TrustArtifactReference = { kind, id };
	if (digest !== undefined && /^[a-f0-9]{64}$/u.test(digest)) {
		reference.digest = { algorithm: "sha256", value: digest };
	}
	return reference;
}

function receiptReference(receipt: PersistedRunReceiptTrustFacts): TrustArtifactReference {
	return sha256Reference("run_receipt", receipt.runId, receipt.integrity?.digest);
}

function attributed<State extends string>(
	state: State,
	source: TrustStatusSource,
	authority: TrustStatusAuthority,
	artifacts: ReadonlyArray<TrustArtifactReference>,
): AttributedState<State> {
	return { state, source, authority, artifacts: [...artifacts].sort(compareArtifactReferences) };
}

function receiptSource(receipt: PersistedRunReceiptTrustFacts): TrustStatusSource {
	return { kind: "run_receipt", id: receipt.runId };
}

function compatibilitySource(receipt: PersistedRunReceiptTrustFacts, field: string): TrustStatusSource {
	return { kind: "compatibility", id: `run_receipt:${receipt.runId}:${field}` };
}

const DISPATCH_AUTHORITY: TrustStatusAuthority = { kind: "clio", id: "dispatch" };
const COMPATIBILITY_AUTHORITY: TrustStatusAuthority = { kind: "unknown", id: "historical-persisted-format" };

/**
 * A receipt sealed under an integrity version this build no longer verifies.
 * It is not migrated and not read as evidence, on the same terms as every
 * prior integrity bump, but it is not a tampered receipt either: nothing was
 * checked, so nothing failed. The outcome names both versions so an operator
 * with a store full of last release's runs can tell a retired seal from a
 * broken one.
 */
export interface RetiredReceiptIntegrity {
	receiptVersion: number;
	supportedVersion: number;
}

/**
 * The dispatch verifier's result, widened with the retired-format diagnosis
 * this module puts in front of it. A failure without `retired` is the
 * verifier's own verdict: a malformed seal, a ledger mismatch, or a digest
 * that does not match the receipt's contents.
 */
export type ReceiptIntegrityOutcome = { ok: true } | { ok: false; reason: string; retired?: RetiredReceiptIntegrity };

/** The retired-version diagnosis for a receipt's integrity block, or null when the block is current or unreadable. */
export function retiredReceiptIntegrity(integrity: unknown): RetiredReceiptIntegrity | null {
	if (!isRecord(integrity)) return null;
	const version = integrity.version;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
	if (version >= RUN_RECEIPT_INTEGRITY_VERSION) return null;
	return { receiptVersion: version, supportedVersion: RUN_RECEIPT_INTEGRITY_VERSION };
}

/** The one sentence every surface prints for a retired seal. It never calls the receipt invalid, broken, or corrupt. */
export function retiredReceiptIntegrityReason(retired: RetiredReceiptIntegrity): string {
	return `receipt integrity v${retired.receiptVersion} is retired; this build verifies v${retired.supportedVersion}; the receipt is not read as evidence`;
}

/**
 * Verify a receipt against its ledger row, diagnosing a retired seal before
 * the verifier can report it as a malformed one. Every trust-bearing
 * verification goes through here so the CLI, the bundle, and the TUI receipt
 * view agree on what a retired receipt is.
 */
export function verifyReceiptIntegrityOutcome(receipt: RunReceipt, envelope: RunEnvelope): ReceiptIntegrityOutcome {
	const retired = retiredReceiptIntegrity(receipt.integrity);
	if (retired !== null) return { ok: false, reason: retiredReceiptIntegrityReason(retired), retired };
	return verifyReceiptIntegrity(receipt, envelope);
}

const RETIRED_INTEGRITY_SOURCE = /:integrity-v(\d+)-retired$/u;

function retiredIntegritySourceId(runId: string, receiptVersion: number): string {
	return `run_receipt:${runId}:integrity-v${receiptVersion}-retired`;
}

/**
 * The retired integrity version a projected artifact-integrity axis names, or
 * null when the axis says something else. The compatibility source id is the
 * only place the persisted projection carries the version, so the human clause
 * reads it back from there rather than from the receipt.
 */
export function retiredIntegrityVersionOf(status: ArtifactIntegrityStatus): number | null {
	if (status.state !== "unknown" || status.source.kind !== "compatibility") return null;
	const match = RETIRED_INTEGRITY_SOURCE.exec(status.source.id);
	return match === null ? null : Number(match[1]);
}

/** Adapt receipt integrity verification without reading any receipt claim as self-authenticating. */
export function adaptReceiptIntegrityStatus(
	receipt: PersistedRunReceiptTrustFacts | null | undefined,
	verification?: ReceiptIntegrityOutcome,
): ArtifactIntegrityStatus {
	if (receipt === null || receipt === undefined) return absentTrustStatus("artifact_missing");
	const artifacts = [receiptReference(receipt)];
	// A retired seal was never checked, so the axis is unknown rather than
	// failed, and the compatibility source names the version it was sealed
	// under. `failed` stays reserved for a seal this build verified and rejected.
	if (verification !== undefined && !verification.ok && verification.retired !== undefined) {
		return attributed(
			"unknown",
			{ kind: "compatibility", id: retiredIntegritySourceId(receipt.runId, verification.retired.receiptVersion) },
			COMPATIBILITY_AUTHORITY,
			artifacts,
		);
	}
	if (verification === undefined || (verification.ok && receipt.integrity === undefined)) {
		return attributed(
			"unknown",
			{
				kind: "compatibility",
				id: `run_receipt:${receipt.runId}:${receipt.integrity === undefined ? "integrity-missing" : "integrity-unchecked"}`,
			},
			COMPATIBILITY_AUTHORITY,
			artifacts,
		);
	}
	return attributed(
		verification.ok ? "verified" : "failed",
		{ kind: "receipt_integrity_verification", id: receipt.runId },
		{ kind: "clio", id: "receipt-integrity" },
		artifacts,
	);
}

function validationArtifacts(receipt: PersistedRunReceiptTrustFacts): TrustArtifactReference[] {
	const artifacts = [receiptReference(receipt)];
	for (const fact of receipt.quality?.typedValidations ?? []) {
		artifacts.push(sha256Reference("validation_result", fact.sourceId, fact.validatorDigest));
	}
	const resultContract = receipt.quality?.resultContract;
	if (resultContract !== null && resultContract !== undefined) {
		artifacts.push(sha256Reference("validation_result", resultContract.sourceId, resultContract.validatorDigest));
	}
	return uniqueBoundedReferences(artifacts);
}

function qualityHasFailure(quality: RunReceiptQuality | undefined): boolean {
	if (quality === undefined) return false;
	if (quality.typedValidations.some((fact) => !fact.passed)) return true;
	return quality.resultContract?.conformance === "fail" || quality.resultContract?.quality === "fail";
}

function qualityHasValidation(quality: RunReceiptQuality | undefined): boolean {
	if (quality === undefined) return false;
	if (quality.typedValidations.some((fact) => fact.passed)) return true;
	return quality.resultContract?.quality === "pass";
}

function verificationStatus(
	verification: RunReceiptVerification,
	receipt: PersistedRunReceiptTrustFacts,
	artifacts: TrustArtifactReference[],
): ValidationGroundingStatus {
	if (verification.state === "verified") {
		return attributed("validated", receiptSource(receipt), { kind: "validator", id: verification.basis }, artifacts);
	}
	if (verification.state === "unverified") return absentTrustStatus("not_observed");
	if (verification.state === "not_applicable") {
		return attributed("not_applicable", receiptSource(receipt), DISPATCH_AUTHORITY, artifacts);
	}
	return attributed(
		"unknown",
		receiptSource(receipt),
		verification.basis === "acp-external-unobserved"
			? { kind: "external_system", id: "acp-delegation" }
			: COMPATIBILITY_AUTHORITY,
		artifacts,
	);
}

/** Adapt correctness-bearing receipt facts before the older descriptive marker. */
export function adaptRunReceiptValidationStatus(
	receipt: PersistedRunReceiptTrustFacts | null | undefined,
): ValidationGroundingStatus {
	if (receipt === null || receipt === undefined) return absentTrustStatus("artifact_missing");
	const artifacts = validationArtifacts(receipt);
	if (receipt.hostVerification?.status === "rejected") {
		return attributed("failed", receiptSource(receipt), { kind: "validator", id: "host-verification" }, artifacts);
	}
	if (receipt.hostVerification?.status === "verified") {
		return attributed("validated", receiptSource(receipt), { kind: "validator", id: "host-verification" }, artifacts);
	}
	if (qualityHasFailure(receipt.quality)) {
		return attributed("failed", receiptSource(receipt), { kind: "validator", id: "receipt-quality" }, artifacts);
	}
	if (
		(receipt.validationGrounding?.ungrounded.length ?? 0) > 0 ||
		(receipt.validationGrounding !== undefined &&
			receipt.validationGrounding.claimed > receipt.validationGrounding.grounded)
	) {
		return attributed("ungrounded", receiptSource(receipt), { kind: "validator", id: "command-grounding" }, artifacts);
	}
	if (qualityHasValidation(receipt.quality)) {
		return attributed("validated", receiptSource(receipt), { kind: "validator", id: "receipt-quality" }, artifacts);
	}
	if (receipt.verification !== undefined) {
		return verificationStatus(receipt.verification, receipt, artifacts);
	}
	return attributed("unknown", compatibilitySource(receipt, "verification"), COMPATIBILITY_AUTHORITY, artifacts);
}

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

function recordedProjectContextHash(context: RunProjectContextProvenance | undefined): string | undefined {
	if (context === undefined) return undefined;
	if (context.tier === "bounded") return validBoundedProjectContext(context) ? context.contentHash : undefined;
	return validNoneTierProjectContext(context) ? context.contentHash : undefined;
}

function contextArtifacts(receipt: PersistedRunReceiptTrustFacts): TrustArtifactReference[] {
	const artifacts = [receiptReference(receipt)];
	if (receipt.briefing !== undefined && validBriefing(receipt.briefing)) {
		artifacts.push(sha256Reference("briefing", `${receipt.runId}:briefing`, receipt.briefing.contentHash));
	}
	const recordedHash = recordedProjectContextHash(receipt.projectContext);
	if (recordedHash !== undefined) {
		artifacts.push(sha256Reference("project_context", `${receipt.runId}:project-context`, recordedHash));
	}
	return uniqueBoundedReferences(artifacts);
}

/** Adapt briefing and project-context provenance without treating either hash as correctness evidence. */
export function adaptRunReceiptContextStatus(
	receipt: PersistedRunReceiptTrustFacts | null | undefined,
): ContextProvenanceStatus {
	if (receipt === null || receipt === undefined) return absentTrustStatus("artifact_missing");
	const artifacts = contextArtifacts(receipt);
	const source = receiptSource(receipt);
	const briefingInvalid = receipt.briefing !== undefined && !validBriefing(receipt.briefing);
	if (briefingInvalid) return attributed("invalid", source, DISPATCH_AUTHORITY, artifacts);
	const context = receipt.projectContext;
	if (context === undefined) {
		if (receipt.briefing !== undefined) return attributed("recorded", source, DISPATCH_AUTHORITY, artifacts);
		return attributed("unknown", compatibilitySource(receipt, "projectContext"), COMPATIBILITY_AUTHORITY, artifacts);
	}
	if (context.tier === "none") {
		const bare = context.chars === undefined && context.contentHash === undefined && context.sections === undefined;
		if (bare) {
			// Nothing structured was sent: the axis does not apply unless a
			// briefing was recorded, which is context of its own.
			return receipt.briefing === undefined
				? attributed("not_applicable", source, DISPATCH_AUTHORITY, artifacts)
				: attributed("recorded", source, DISPATCH_AUTHORITY, artifacts);
		}
		// The workspace-root message is the one thing a none-tier run receives,
		// and its record is valid; every other none-tier content shape is a
		// record the policy cannot account for.
		return attributed(
			validNoneTierProjectContext(context) ? "recorded" : "invalid",
			source,
			DISPATCH_AUTHORITY,
			artifacts,
		);
	}
	return attributed(validBoundedProjectContext(context) ? "recorded" : "invalid", source, DISPATCH_AUTHORITY, artifacts);
}

/** Adapt the recorded runtime grade and conservatively recover inconsistent bypass flags. */
export function adaptRunReceiptAutonomyStatus(
	receipt: PersistedRunReceiptTrustFacts | null | undefined,
): AutonomyEnforcementStatus {
	if (receipt === null || receipt === undefined) return absentTrustStatus("artifact_missing");
	const enforcement = receipt.autonomyEnforcement;
	const artifacts = [receiptReference(receipt)];
	if (enforcement === undefined) {
		return attributed("unknown", compatibilitySource(receipt, "autonomyEnforcement"), COMPATIBILITY_AUTHORITY, artifacts);
	}
	artifacts.push({ kind: "autonomy_policy", id: `${receipt.runId}:${enforcement.autonomy}` });
	const authority: TrustStatusAuthority =
		enforcement.grade === "mediated"
			? { kind: "clio", id: "safety-autonomy" }
			: { kind: "runtime", id: enforcement.externalMode ?? "external-runtime" };
	const state =
		enforcement.dangerousBypass === true || enforcement.grade === "bypassed"
			? "bypassed"
			: enforcement.grade === "approximated"
				? "approximated"
				: "enforced";
	return attributed(state, receiptSource(receipt), authority, artifacts);
}

export interface AdaptRunReceiptTrustOptions {
	integrity?: ReceiptIntegrityOutcome;
}

function receiptClaimsAreAuthenticated(
	receipt: PersistedRunReceiptTrustFacts | null | undefined,
	integrity: ReceiptIntegrityOutcome | undefined,
): boolean {
	return receipt?.integrity !== undefined && integrity?.ok === true;
}

function unauthenticatedReceiptProjection(
	receipt: PersistedRunReceiptTrustFacts | null | undefined,
	integrity: ReceiptIntegrityOutcome | undefined,
): TrustStatusProjection {
	if (receipt === null || receipt === undefined) {
		return {
			validationGrounding: absentTrustStatus("artifact_missing"),
			contextProvenance: absentTrustStatus("artifact_missing"),
			autonomyEnforcement: absentTrustStatus("artifact_missing"),
		};
	}
	if (receipt.integrity === undefined) {
		const artifacts = [receiptReference(receipt)];
		return {
			validationGrounding: attributed(
				"unknown",
				compatibilitySource(receipt, "canonical-projection"),
				COMPATIBILITY_AUTHORITY,
				artifacts,
			),
			contextProvenance: attributed(
				"unknown",
				compatibilitySource(receipt, "canonical-projection"),
				COMPATIBILITY_AUTHORITY,
				artifacts,
			),
			autonomyEnforcement: attributed(
				"unknown",
				compatibilitySource(receipt, "canonical-projection"),
				COMPATIBILITY_AUTHORITY,
				artifacts,
			),
		};
	}
	// A retired seal leaves the receipt unread rather than rejected: its axes
	// are absent because the format is historical, not because a check failed.
	if (integrity !== undefined && !integrity.ok && integrity.retired !== undefined) {
		return {
			validationGrounding: absentTrustStatus("historical_format"),
			contextProvenance: absentTrustStatus("historical_format"),
			autonomyEnforcement: absentTrustStatus("historical_format"),
		};
	}
	// The artifact-integrity axis retains the failure diagnostic. No other
	// axis reads a field from a receipt that failed authentication.
	return {
		validationGrounding: absentTrustStatus("not_observed"),
		contextProvenance: absentTrustStatus("not_observed"),
		autonomyEnforcement: absentTrustStatus("not_observed"),
	};
}

/** Build the receipt-owned projection. Gate and finish facts remain absent until explicitly composed. */
export function adaptRunReceiptTrustStatus(
	receipt: PersistedRunReceiptTrustFacts | null | undefined,
	options: AdaptRunReceiptTrustOptions = {},
): CanonicalTrustStatus {
	const authenticated = receiptClaimsAreAuthenticated(receipt, options.integrity);
	const receiptProjection = authenticated
		? {
				validationGrounding: adaptRunReceiptValidationStatus(receipt),
				contextProvenance: adaptRunReceiptContextStatus(receipt),
				autonomyEnforcement: adaptRunReceiptAutonomyStatus(receipt),
			}
		: unauthenticatedReceiptProjection(receipt, options.integrity);
	return composeTrustStatus({
		artifactIntegrity: adaptReceiptIntegrityStatus(receipt, options.integrity),
		...receiptProjection,
		independentReview: absentTrustStatus(receipt === null || receipt === undefined ? "artifact_missing" : "not_recorded"),
		completionEvidence: absentTrustStatus(
			receipt === null || receipt === undefined ? "artifact_missing" : "not_recorded",
		),
	});
}

export interface RunReceiptTrustInspection {
	integrity: ReceiptIntegrityOutcome;
	status: CanonicalTrustStatus;
}

/**
 * Inspect a receipt and ledger envelope through one pure authentication and
 * projection boundary. Callers retain the integrity result as the diagnostic
 * and consume `status` for every trust-bearing presentation.
 */
export function inspectRunReceiptTrustStatus(
	receipt: RunReceipt | null | undefined,
	envelope: RunEnvelope | null | undefined,
): RunReceiptTrustInspection {
	let integrity: ReceiptIntegrityOutcome;
	if (receipt === null || receipt === undefined) {
		integrity = { ok: false, reason: "receipt unavailable" };
	} else if (envelope === null || envelope === undefined) {
		integrity = { ok: false, reason: "run ledger envelope unavailable" };
	} else {
		try {
			integrity = verifyReceiptIntegrityOutcome(receipt, envelope);
		} catch (error) {
			integrity = {
				ok: false,
				reason: `receipt invalid: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	return {
		integrity,
		status: adaptRunReceiptTrustStatus(receipt, { integrity }),
	};
}

function gateReference(artifact: GateDecisionArtifact): TrustArtifactReference {
	return sha256Reference("gate_decision", artifact.id, artifact.integrity.digest);
}

function gateAuthority(artifact: GateDecisionArtifact): TrustStatusAuthority {
	if (artifact.outcome === "operator-confirmed") return { kind: "operator", id: "gate-confirmation" };
	if (artifact.outcome === "full-auto-applied") return { kind: "clio", id: "full-auto-gate-policy" };
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
		if (artifact.outcome === "operator-confirmed" || artifact.outcome === "full-auto-applied") {
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

export interface GroundedEvidenceValidationInput {
	evidenceId: string;
	runId: string;
	artifacts?: ReadonlyArray<TrustArtifactReference>;
}

/**
 * Project validation that the evidence linker grounded in an executed
 * artifact. Grounding requires at least one independently observed artifact:
 * a self-report of the run under inspection cannot ground its own validation
 * (docs/evidence-and-memory.md, "composition rules"), and an empty reference
 * list grounds
 * nothing at all.
 */
export function adaptGroundedEvidenceValidationStatus(
	input: GroundedEvidenceValidationInput,
): ValidationGroundingStatus {
	const observed = (input.artifacts ?? []).filter((artifact) => !SELF_REPORTED_ARTIFACT_KINDS.has(artifact.kind));
	if (observed.length === 0) return absentTrustStatus("not_observed");
	return attributed(
		"validated",
		{ kind: "evidence_bundle", id: `${input.evidenceId}:${input.runId}` },
		{ kind: "clio", id: "evidence-grounding" },
		uniqueBoundedReferences([{ kind: "evidence_bundle", id: input.evidenceId }, ...observed]),
	);
}

export interface AdaptFinishContractTrustOptions {
	sourceId?: string;
	artifacts?: ReadonlyArray<TrustArtifactReference>;
}

/** Map the live finish contract onto completion evidence without inferring completion from autonomy. */
export function adaptFinishContractCompletionStatus(
	assessment: FinishContractAssessment,
	options: AdaptFinishContractTrustOptions = {},
): CompletionEvidenceStatus {
	const artifacts = uniqueBoundedReferences(
		options.artifacts ??
			assessment.evidence.map((evidence, index) => ({
				kind: evidence.turnId === undefined ? "finish_contract_evidence" : "session_entry",
				id: evidence.turnId ?? `${evidence.kind}:${index + 1}`,
			})),
	);
	const source: TrustStatusSource = { kind: "finish_contract", id: options.sourceId ?? assessment.reason };
	const authority: TrustStatusAuthority = { kind: "clio", id: "finish-contract" };
	if (assessment.reason === "no_mutation") return attributed("not_applicable", source, authority, artifacts);
	if (assessment.reason === "validation_evidence") return attributed("evidenced", source, authority, artifacts);
	if (assessment.reason === "explicit_limitation") return attributed("limited", source, authority, artifacts);
	return attributed("incomplete", source, authority, artifacts);
}

function uniqueBoundedReferences(references: ReadonlyArray<TrustArtifactReference>): TrustArtifactReference[] {
	const sorted = [...references].sort(compareArtifactReferences);
	const unique = sorted.filter(
		(reference, index) =>
			index === 0 || compareArtifactReferences(sorted[index - 1] as TrustArtifactReference, reference) !== 0,
	);
	return unique.slice(0, TRUST_STATUS_MAX_ARTIFACT_REFERENCES);
}
