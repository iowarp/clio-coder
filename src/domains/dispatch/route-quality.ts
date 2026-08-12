import { createHash } from "node:crypto";
import { gateRouteCorrelation } from "./execution-role.js";
import { type GateDecisionArtifact, verifyGateDecisionArtifact } from "./gate-decisions.js";
import { verifyReceiptIntegrity } from "./receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "./types.js";

/** A routing label is deliberately separate from the descriptive receipt verification state. */
export type RouteQualityLabel = "pass" | "fail" | "unmeasured";

export interface RouteQualityCheck {
	kind: "typed-validation" | "result-contract" | "independent-gate" | "evaluation";
	sourceDigest: string;
	passed: boolean;
}

export interface CorrelatedGateEvidence {
	sourceDigest: string;
	outcome: "pass" | "fail";
	reason: "same-agent" | "same-model-family";
	/** Every correlated route dimension, so a small fleet reports rather than hides it. */
	dimensions: string[];
}

export interface RouteQualityReduction {
	label: RouteQualityLabel;
	/** Trusted correctness-bearing checks, sorted for deterministic replay. */
	checks: RouteQualityCheck[];
	/** Valid gate verdicts that are intentionally not used as labels. */
	correlatedGates: CorrelatedGateEvidence[];
	/** Every authenticated source digest that contributed to this reduction. */
	sourceDigests: string[];
}

export interface RouteQualityReceiptSource {
	receipt: RunReceipt;
	envelope: RunEnvelope;
}

/** The current eval artifact projection consumed by routing. Older formats are not evidence. */
export interface RouteQualityEvalArtifact {
	version: 4;
	evalId: string;
	results: ReadonlyArray<{
		assignmentId: string | null;
		terminalReceiptDigest: string | null;
		pass: boolean;
	}>;
}

export interface RouteQualityEvalSource {
	artifact: RouteQualityEvalArtifact;
	/** Canonical digest of the durable current-version artifact. */
	digest: string;
}

export interface ReduceRouteQualityInput {
	subject: RouteQualityReceiptSource;
	/** Receipts referenced by later evidence, including the subject. */
	receipts: ReadonlyArray<RouteQualityReceiptSource>;
	gateArtifacts?: ReadonlyArray<GateDecisionArtifact>;
	evalArtifacts?: ReadonlyArray<RouteQualityEvalSource>;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Integrity verdicts held against the receipt object that produced them.
 *
 * Verification canonically serializes and hashes a receipt and its envelope,
 * and `reduceRouteQuality` verifies the whole receipt set on every call. That
 * is fine for one subject and quadratic for a batch. Reconciling route history
 * is a batch: 359 records against a 1247-receipt ledger is 447,673
 * verifications of files averaging 23KB, which measured 70 seconds of CPU on
 * the dispatch decision path and pushed every dispatch on this machine past
 * its 60-second admission deadline. Dispatch had stopped working, and the
 * error it reported was that no worker slots were free while zero were in use.
 *
 * The key is the receipt object, not its digest. A digest key would let a
 * forged receipt claiming a known-good digest inherit that receipt's verdict,
 * which is the thing verification exists to catch. Object identity can only be
 * shared by a receipt that was already verified in this process, and a durable
 * re-read produces fresh objects, so a ledger that changed on disk is verified
 * again.
 */
const integrityVerdicts = new WeakMap<object, boolean>();

function authenticated(source: RouteQualityReceiptSource): boolean {
	const cached = integrityVerdicts.get(source.receipt);
	if (cached !== undefined) return cached;
	const verdict = verifyReceiptIntegrity(source.receipt, source.envelope).ok;
	integrityVerdicts.set(source.receipt, verdict);
	return verdict;
}

function receiptSourcesByRunId(
	sources: ReadonlyArray<RouteQualityReceiptSource>,
): Map<string, RouteQualityReceiptSource> {
	const result = new Map<string, RouteQualityReceiptSource>();
	for (const source of sources) {
		if (!authenticated(source)) continue;
		result.set(source.receipt.runId, source);
	}
	return result;
}

function gateReferencesMatch(
	artifact: GateDecisionArtifact,
	receipts: ReadonlyMap<string, RouteQualityReceiptSource>,
): boolean {
	const references = [...artifact.subjects, ...(artifact.decider === undefined ? [] : [artifact.decider])];
	return references.every((reference) => receipts.get(reference.runId)?.receipt.integrity.digest === reference.digest);
}

function gateOutcome(artifact: GateDecisionArtifact): "pass" | "fail" | null {
	if (artifact.outcome === "pass") return "pass";
	if (artifact.outcome === "fail") return "fail";
	// An integrity-valid operator-confirmed compete decision proves only the
	// applied winner's positive verdict; losing candidates stay unmeasured.
	if (artifact.outcome === "operator-confirmed" && artifact.confirmation !== undefined) return "pass";
	return null;
}

function correlationFacts(receipt: RunReceipt): Parameters<typeof gateRouteCorrelation>[0] {
	return {
		agentId: receipt.agentId,
		targetId: receipt.targetId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		nodeId: receipt.node?.id ?? "local",
	};
}

function gateCorrelation(
	subject: RunReceipt,
	decider: RunReceipt,
): Pick<CorrelatedGateEvidence, "reason" | "dimensions"> | null {
	const correlation = gateRouteCorrelation(correlationFacts(subject), correlationFacts(decider));
	if (correlation.independent) return null;
	return {
		reason: correlation.agent ? "same-agent" : "same-model-family",
		dimensions: correlation.dimensions,
	};
}

function evalAssignmentId(receipt: RunReceipt): string {
	return receipt.lineage?.rootRunId ?? receipt.runId;
}

/**
 * Reduce integrity-valid receipt, gate, and eval artifacts into one routing
 * quality label. It is intentionally pure: callers own durable reads and
 * persistence, so replaying the same authenticated inputs is byte-identical.
 */
export function reduceRouteQuality(input: ReduceRouteQualityInput): RouteQualityReduction {
	if (!authenticated(input.subject)) {
		return { label: "unmeasured", checks: [], correlatedGates: [], sourceDigests: [] };
	}

	const subject = input.subject.receipt;
	const receipts = receiptSourcesByRunId([input.subject, ...input.receipts]);
	const checks: RouteQualityCheck[] = [];
	const correlatedGates: CorrelatedGateEvidence[] = [];
	const sourceDigests = new Set<string>([subject.integrity.digest]);

	for (const fact of subject.quality.typedValidations) {
		checks.push({
			kind: "typed-validation",
			sourceDigest: subject.integrity.digest,
			passed: fact.passed,
		});
	}
	const resultContract = subject.quality.resultContract;
	if (resultContract !== null && resultContract.quality !== "unmeasured") {
		checks.push({
			kind: "result-contract",
			sourceDigest: subject.integrity.digest,
			passed: resultContract.quality === "pass",
		});
	}

	for (const artifact of input.gateArtifacts ?? []) {
		if (!verifyGateDecisionArtifact(artifact).ok || !gateReferencesMatch(artifact, receipts)) continue;
		const verdict = gateOutcome(artifact);
		if (verdict === null || artifact.decider === undefined) continue;
		const subjectReference = artifact.subjects.find(
			(reference) => reference.runId === subject.runId && reference.digest === subject.integrity.digest,
		);
		if (subjectReference === undefined) continue;
		const operatorConfirmed = artifact.outcome === "operator-confirmed" && artifact.confirmation !== undefined;
		if (
			operatorConfirmed &&
			(artifact.winner === undefined ||
				artifact.winner.subject.runId !== subject.runId ||
				artifact.winner.subject.digest !== subject.integrity.digest)
		)
			continue;
		const decider = receipts.get(artifact.decider.runId)?.receipt;
		if (decider === undefined) continue;
		const correlation = gateCorrelation(subject, decider);
		sourceDigests.add(artifact.integrity.digest);
		if (correlation !== null && !operatorConfirmed) {
			correlatedGates.push({ sourceDigest: artifact.integrity.digest, outcome: verdict, ...correlation });
			continue;
		}
		checks.push({ kind: "independent-gate", sourceDigest: artifact.integrity.digest, passed: verdict === "pass" });
	}

	for (const source of input.evalArtifacts ?? []) {
		if (source.artifact.version !== 4 || !/^[0-9a-f]{64}$/u.test(source.digest)) continue;
		for (const result of source.artifact.results) {
			if (result.assignmentId !== evalAssignmentId(subject) || result.terminalReceiptDigest !== subject.integrity.digest)
				continue;
			sourceDigests.add(source.digest);
			checks.push({ kind: "evaluation", sourceDigest: source.digest, passed: result.pass });
		}
	}

	checks.sort((left, right) => {
		const byKind = compareStrings(left.kind, right.kind);
		if (byKind !== 0) return byKind;
		if (left.sourceDigest !== right.sourceDigest) return compareStrings(left.sourceDigest, right.sourceDigest);
		return Number(left.passed) - Number(right.passed);
	});
	correlatedGates.sort((left, right) => compareStrings(left.sourceDigest, right.sourceDigest));
	const label: RouteQualityLabel = checks.some((check) => !check.passed)
		? "fail"
		: checks.some((check) => check.passed)
			? "pass"
			: "unmeasured";
	return { label, checks, correlatedGates, sourceDigests: [...sourceDigests].sort(compareStrings) };
}

/** Stable digest for a current eval artifact when it enters route history. */
export function routeQualityEvalDigest(artifact: RouteQualityEvalArtifact): string {
	return createHash("sha256").update(canonicalJson(artifact), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("route quality eval digest requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort(compareStrings)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new Error(`route quality eval digest cannot represent ${typeof value}`);
}
