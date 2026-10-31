import { gateRouteCorrelation } from "./execution-role.js";
import { type GateDecisionArtifact, verifyGateDecisionArtifact } from "./gate-decisions.js";
import type { RunResult } from "./types.js";

/** A routing label is deliberately separate from the descriptive receipt verification state. */
export type RouteQualityLabel = "pass" | "fail" | "unmeasured";

export interface RouteQualityCheck {
	kind: "typed-validation" | "result-contract" | "independent-gate";
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

/**
 * What route quality reads of a finished run: its identity, route and quality facts. A run its producer holds and a
 * run read back under a verified seal both carry them, so a reduction never reads a run that is not authentic (#434).
 */
export interface RouteQualityRun {
	runId: string;
	digest: string;
	agentId: string;
	route: { targetId: string; wireModelId: string; runtimeId: string };
	node: { id: string } | null;
	quality: {
		typedValidations: ReadonlyArray<{ passed: boolean }>;
		resultContract: { quality: "pass" | "fail" | "unmeasured" } | null;
	} | null;
}

/** The route-quality view of a result its producer holds. */
export function routeQualityRun(result: RunResult): RouteQualityRun {
	return {
		runId: result.runId,
		digest: result.digest,
		agentId: result.agentId,
		route: { targetId: result.targetId, wireModelId: result.wireModelId, runtimeId: result.runtimeId },
		node: result.node ? { id: result.node.id } : null,
		quality: result.quality,
	};
}

export interface ReduceRouteQualityInput {
	subject: RouteQualityRun;
	/** Runs referenced by later evidence, including the subject. */
	runs: ReadonlyArray<RouteQualityRun>;
	gateArtifacts?: ReadonlyArray<GateDecisionArtifact>;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Gate verdicts held against the artifact object that produced them: a durable re-read produces fresh objects, so an
 * artifact that changed on disk is verified again, and a forged one never inherits a known-good verdict.
 */
const gateVerdicts = new WeakMap<object, boolean>();

function gateAuthenticated(artifact: GateDecisionArtifact): boolean {
	const cached = gateVerdicts.get(artifact);
	if (cached !== undefined) return cached;
	const verdict = verifyGateDecisionArtifact(artifact).ok;
	gateVerdicts.set(artifact, verdict);
	return verdict;
}

function runsByRunId(runs: ReadonlyArray<RouteQualityRun>): Map<string, RouteQualityRun> {
	return new Map(runs.map((run) => [run.runId, run]));
}

function gateReferencesMatch(artifact: GateDecisionArtifact, runs: ReadonlyMap<string, RouteQualityRun>): boolean {
	const references = [...artifact.subjects, ...(artifact.decider === undefined ? [] : [artifact.decider])];
	return references.every((reference) => runs.get(reference.runId)?.digest === reference.digest);
}

function gateOutcome(artifact: GateDecisionArtifact): "pass" | "fail" | null {
	if (artifact.outcome === "pass") return "pass";
	if (artifact.outcome === "fail") return "fail";
	// An integrity-valid operator-confirmed compete decision proves only the
	// applied winner's positive verdict; losing candidates stay unmeasured.
	if (artifact.outcome === "operator-confirmed" && artifact.confirmation !== undefined) return "pass";
	return null;
}

function correlationFacts(run: RouteQualityRun): Parameters<typeof gateRouteCorrelation>[0] {
	return {
		agentId: run.agentId,
		targetId: run.route.targetId,
		wireModelId: run.route.wireModelId,
		runtimeId: run.route.runtimeId,
		nodeId: run.node?.id ?? "local",
	};
}

function gateCorrelation(
	subject: RouteQualityRun,
	decider: RouteQualityRun,
): Pick<CorrelatedGateEvidence, "reason" | "dimensions"> | null {
	const correlation = gateRouteCorrelation(correlationFacts(subject), correlationFacts(decider));
	if (correlation.independent) return null;
	return {
		reason: correlation.agent ? "same-agent" : "same-model-family",
		dimensions: correlation.dimensions,
	};
}

/**
 * Reduce authenticated runs and gate artifacts into one routing quality label. It is intentionally pure: callers own
 * durable reads and persistence, so replaying the same authenticated inputs is byte-identical.
 */
export function reduceRouteQuality(input: ReduceRouteQualityInput): RouteQualityReduction {
	const subject = input.subject;
	const runs = runsByRunId([input.subject, ...input.runs]);
	const checks: RouteQualityCheck[] = [];
	const correlatedGates: CorrelatedGateEvidence[] = [];
	const sourceDigests = new Set<string>([subject.digest]);

	for (const fact of subject.quality?.typedValidations ?? []) {
		checks.push({
			kind: "typed-validation",
			sourceDigest: subject.digest,
			passed: fact.passed,
		});
	}
	const resultContract = subject.quality?.resultContract ?? null;
	if (resultContract !== null && resultContract.quality !== "unmeasured") {
		checks.push({
			kind: "result-contract",
			sourceDigest: subject.digest,
			passed: resultContract.quality === "pass",
		});
	}

	for (const artifact of input.gateArtifacts ?? []) {
		if (!gateAuthenticated(artifact) || !gateReferencesMatch(artifact, runs)) continue;
		const verdict = gateOutcome(artifact);
		if (verdict === null || artifact.decider === undefined) continue;
		const subjectReference = artifact.subjects.find(
			(reference) => reference.runId === subject.runId && reference.digest === subject.digest,
		);
		if (subjectReference === undefined) continue;
		const operatorConfirmed = artifact.outcome === "operator-confirmed" && artifact.confirmation !== undefined;
		if (
			operatorConfirmed &&
			(artifact.winner === undefined ||
				artifact.winner.subject.runId !== subject.runId ||
				artifact.winner.subject.digest !== subject.digest)
		)
			continue;
		const decider = runs.get(artifact.decider.runId);
		if (decider === undefined) continue;
		const correlation = gateCorrelation(subject, decider);
		sourceDigests.add(artifact.integrity.digest);
		if (correlation !== null && !operatorConfirmed) {
			correlatedGates.push({ sourceDigest: artifact.integrity.digest, outcome: verdict, ...correlation });
			continue;
		}
		checks.push({ kind: "independent-gate", sourceDigest: artifact.integrity.digest, passed: verdict === "pass" });
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
