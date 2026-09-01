import type { EvalArtifactResultV4 } from "../schema/artifact.js";
import type { EvalExecutionEnvelopeV1, EvalExecutionMatrixDimensionV1 } from "../schema/execution-envelope.js";

export interface EvalEnvelopeMismatchV1 {
	scenarioId: string;
	role: string;
	target: { id: string; model: string | null };
	fields: string[];
}

export interface EvalEnvelopeComparabilityV1 {
	comparable: boolean;
	mismatchedFields: string[];
}

export function compareEvalExecutionEnvelopesV1(
	identity: { scenarioId: string; role: string; target: { id: string; model: string | null } },
	baseline: ReadonlyArray<EvalArtifactResultV4>,
	candidate: ReadonlyArray<EvalArtifactResultV4>,
	baselineDimensions: ReadonlyArray<EvalExecutionMatrixDimensionV1>,
	candidateDimensions: ReadonlyArray<EvalExecutionMatrixDimensionV1>,
): EvalEnvelopeMismatchV1 | null {
	const leftDimensions = [...baselineDimensions].sort();
	const rightDimensions = [...candidateDimensions].sort();
	if (stableJson(leftDimensions) !== stableJson(rightDimensions)) {
		return { ...identity, fields: ["matrix.dimensions"] };
	}
	if (
		(baseline.some((result) => result.executionEnvelope !== undefined) &&
			baseline.some((result) => result.executionEnvelope === undefined)) ||
		(candidate.some((result) => result.executionEnvelope !== undefined) &&
			candidate.some((result) => result.executionEnvelope === undefined))
	) {
		return { ...identity, fields: ["executionEnvelope.missingTrial"] };
	}
	const ignored = new Set(leftDimensions);
	const baselineEnvelopes = uniqueEnvelopes(baseline, ignored);
	const candidateEnvelopes = uniqueEnvelopes(candidate, ignored);
	if (baselineEnvelopes.length === 0 && candidateEnvelopes.length === 0) return null;
	if (baselineEnvelopes.length === 0 || candidateEnvelopes.length === 0) {
		return { ...identity, fields: ["executionEnvelope"] };
	}
	if (baselineEnvelopes.length > 1 || candidateEnvelopes.length > 1) {
		return { ...identity, fields: ["executionEnvelope.withinRunVariance"] };
	}
	const left = baselineEnvelopes[0];
	const right = candidateEnvelopes[0];
	if (left === undefined || right === undefined || stableJson(left) === stableJson(right)) return null;
	return { ...identity, fields: differingFields(left, right, ignored) };
}

function uniqueEnvelopes(
	results: ReadonlyArray<EvalArtifactResultV4>,
	ignored: ReadonlySet<EvalExecutionMatrixDimensionV1>,
): EvalExecutionEnvelopeV1[] {
	const byIdentity = new Map<string, EvalExecutionEnvelopeV1>();
	for (const result of results) {
		if (result.executionEnvelope === undefined) continue;
		const normalized = normalizedEnvelope(result.executionEnvelope, ignored);
		byIdentity.set(stableJson(normalized), normalized);
	}
	return [...byIdentity.values()];
}

function normalizedEnvelope(
	envelope: EvalExecutionEnvelopeV1,
	ignored: ReadonlySet<EvalExecutionMatrixDimensionV1>,
): EvalExecutionEnvelopeV1 {
	return {
		...envelope,
		prompt: ignored.has("prompt") ? { fragments: [], compositionHash: null } : envelope.prompt,
		recipe: ignored.has("recipe") ? null : envelope.recipe,
		target: ignored.has("target") ? "<matrix>" : envelope.target,
		wireModel: ignored.has("wireModel") ? null : envelope.wireModel,
		runtime: ignored.has("runtime") ? null : envelope.runtime,
		thinkingLevel: ignored.has("thinkingLevel") ? null : envelope.thinkingLevel,
		toolSignature: ignored.has("toolSignature") ? null : envelope.toolSignature,
		autonomy: ignored.has("autonomy") ? null : envelope.autonomy,
		policyHashes: ignored.has("policy") ? { rulePack: null, project: null } : envelope.policyHashes,
		projectContext: ignored.has("projectContext")
			? {
					kind: "none",
					tier: null,
					contentHash: null,
					chars: null,
					sections: [],
					rulesApplied: [],
					operatorProfileApplied: null,
				}
			: envelope.projectContext,
		corpus: ignored.has("corpus") ? { id: "<matrix>", version: "<matrix>" } : envelope.corpus,
	};
}

function differingFields(
	left: EvalExecutionEnvelopeV1,
	right: EvalExecutionEnvelopeV1,
	ignored: ReadonlySet<EvalExecutionMatrixDimensionV1>,
): string[] {
	const fields: Array<[EvalExecutionMatrixDimensionV1, string, unknown, unknown]> = [
		["prompt", "prompt", left.prompt, right.prompt],
		["recipe", "recipe", left.recipe, right.recipe],
		["target", "target", left.target, right.target],
		["wireModel", "wireModel", left.wireModel, right.wireModel],
		["runtime", "runtime", left.runtime, right.runtime],
		["thinkingLevel", "thinkingLevel", left.thinkingLevel, right.thinkingLevel],
		["toolSignature", "toolSignature", left.toolSignature, right.toolSignature],
		["autonomy", "autonomy", left.autonomy, right.autonomy],
		["policy", "policyHashes", left.policyHashes, right.policyHashes],
		["projectContext", "projectContext", left.projectContext, right.projectContext],
		["corpus", "corpus", left.corpus, right.corpus],
	];
	return fields.flatMap(([dimension, field, baseline, candidate]) =>
		ignored.has(dimension) || stableJson(baseline) === stableJson(candidate) ? [] : [field],
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
