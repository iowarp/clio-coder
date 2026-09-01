export const EVAL_EXECUTION_ENVELOPE_SCHEMA_V1 = "clio.eval.execution-envelope.v1" as const;

export const EVAL_EXECUTION_MATRIX_DIMENSIONS_V1 = [
	"prompt",
	"recipe",
	"target",
	"wireModel",
	"runtime",
	"thinkingLevel",
	"toolSignature",
	"autonomy",
	"policy",
	"projectContext",
	"corpus",
] as const;

export type EvalExecutionMatrixDimensionV1 = (typeof EVAL_EXECUTION_MATRIX_DIMENSIONS_V1)[number];
export type EvalPromptFragmentVersionV1 = number | "unversioned";

export interface EvalPromptFragmentIdentityV1 {
	id: string;
	version: EvalPromptFragmentVersionV1;
	contentHash: string;
}

export interface EvalExecutionEnvelopeV1 {
	schema: typeof EVAL_EXECUTION_ENVELOPE_SCHEMA_V1;
	prompt: {
		fragments: EvalPromptFragmentIdentityV1[];
		/** Null means the machinery-only scenario made no model request. */
		compositionHash: string | null;
	};
	/** Null for a main-agent or machinery runner that does not execute an agent recipe. */
	recipe: { id: string; version: number; contentHash: string } | null;
	target: string;
	wireModel: string | null;
	runtime: string | null;
	thinkingLevel: string | null;
	toolSignature: string | null;
	autonomy: string | null;
	policyHashes: {
		rulePack: string | null;
		project: string | null;
	};
	projectContext: {
		kind: "none" | "session" | "worker";
		tier: string | null;
		contentHash: string | null;
		chars: number | null;
		sections: string[];
		rulesApplied: string[];
		operatorProfileApplied: boolean | null;
	};
	corpus: { id: string; version: string };
}

export function parseEvalExecutionEnvelopeV1(value: unknown, source = "execution envelope"): EvalExecutionEnvelopeV1 {
	const record = asRecord(value, source);
	if (record.schema !== EVAL_EXECUTION_ENVELOPE_SCHEMA_V1) {
		throw new Error(`${source}.schema: expected ${EVAL_EXECUTION_ENVELOPE_SCHEMA_V1}`);
	}
	const prompt = asRecord(record.prompt, `${source}.prompt`);
	if (!Array.isArray(prompt.fragments)) throw new Error(`${source}.prompt.fragments: expected array`);
	const fragments = prompt.fragments.map((entry, index) => {
		const fragment = asRecord(entry, `${source}.prompt.fragments[${index}]`);
		const version = fragment.version;
		if (version !== "unversioned" && (!Number.isInteger(version) || typeof version !== "number" || version <= 0)) {
			throw new Error(`${source}.prompt.fragments[${index}].version: expected positive integer or unversioned`);
		}
		return {
			id: readString(fragment.id, `${source}.prompt.fragments[${index}].id`),
			version: version as EvalPromptFragmentVersionV1,
			contentHash: readDigest(fragment.contentHash, `${source}.prompt.fragments[${index}].contentHash`),
		};
	});
	const fragmentIds = fragments.map((fragment) => fragment.id);
	if (new Set(fragmentIds).size !== fragmentIds.length) {
		throw new Error(`${source}.prompt.fragments: duplicate fragment id`);
	}
	const recipe =
		record.recipe === null
			? null
			: (() => {
					const value = asRecord(record.recipe, `${source}.recipe`);
					const version = value.version;
					if (!Number.isInteger(version) || typeof version !== "number" || version <= 0) {
						throw new Error(`${source}.recipe.version: expected positive integer`);
					}
					return {
						id: readString(value.id, `${source}.recipe.id`),
						version,
						contentHash: readDigest(value.contentHash, `${source}.recipe.contentHash`),
					};
				})();
	const policyHashes = asRecord(record.policyHashes, `${source}.policyHashes`);
	const projectContext = asRecord(record.projectContext, `${source}.projectContext`);
	const projectKind = projectContext.kind;
	if (projectKind !== "none" && projectKind !== "session" && projectKind !== "worker") {
		throw new Error(`${source}.projectContext.kind: expected none, session, or worker`);
	}
	const corpus = asRecord(record.corpus, `${source}.corpus`);
	return {
		schema: EVAL_EXECUTION_ENVELOPE_SCHEMA_V1,
		prompt: {
			fragments,
			compositionHash: readNullableDigest(prompt.compositionHash, `${source}.prompt.compositionHash`),
		},
		recipe,
		target: readString(record.target, `${source}.target`),
		wireModel: readNullableString(record.wireModel, `${source}.wireModel`),
		runtime: readNullableString(record.runtime, `${source}.runtime`),
		thinkingLevel: readNullableString(record.thinkingLevel, `${source}.thinkingLevel`),
		toolSignature: readNullableDigest(record.toolSignature, `${source}.toolSignature`),
		autonomy: readNullableString(record.autonomy, `${source}.autonomy`),
		policyHashes: {
			rulePack: readNullableDigest(policyHashes.rulePack, `${source}.policyHashes.rulePack`),
			project: readNullableDigest(policyHashes.project, `${source}.policyHashes.project`),
		},
		projectContext: {
			kind: projectKind,
			tier: readNullableString(projectContext.tier, `${source}.projectContext.tier`),
			contentHash: readNullableDigest(projectContext.contentHash, `${source}.projectContext.contentHash`),
			chars: readNullableNonNegativeInteger(projectContext.chars, `${source}.projectContext.chars`),
			sections: readStringArray(projectContext.sections, `${source}.projectContext.sections`),
			rulesApplied: readStringArray(projectContext.rulesApplied, `${source}.projectContext.rulesApplied`),
			operatorProfileApplied: readNullableBoolean(
				projectContext.operatorProfileApplied,
				`${source}.projectContext.operatorProfileApplied`,
			),
		},
		corpus: {
			id: readString(corpus.id, `${source}.corpus.id`),
			version: readString(corpus.version, `${source}.corpus.version`),
		},
	};
}

export function parseEvalExecutionMatrixDimensionsV1(value: unknown, source: string): EvalExecutionMatrixDimensionV1[] {
	if (!Array.isArray(value)) throw new Error(`${source}: expected array`);
	const allowed = new Set<string>(EVAL_EXECUTION_MATRIX_DIMENSIONS_V1);
	const dimensions = value.map((entry, index) => {
		if (typeof entry !== "string" || !allowed.has(entry)) {
			throw new Error(`${source}[${index}]: expected a declared execution-envelope dimension`);
		}
		return entry as EvalExecutionMatrixDimensionV1;
	});
	if (new Set(dimensions).size !== dimensions.length) throw new Error(`${source}: duplicate matrix dimension`);
	return dimensions;
}

function readString(value: unknown, source: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}: expected non-empty string`);
	return value;
}

function readNullableString(value: unknown, source: string): string | null {
	if (value === null) return null;
	return readString(value, source);
}

function readDigest(value: unknown, source: string): string {
	const digest = readString(value, source);
	if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${source}: expected sha256 digest`);
	return digest;
}

function readNullableDigest(value: unknown, source: string): string | null {
	return value === null ? null : readDigest(value, source);
}

function readNullableNonNegativeInteger(value: unknown, source: string): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${source}: expected non-negative integer or null`);
	}
	return value;
}

function readNullableBoolean(value: unknown, source: string): boolean | null {
	if (value === null || typeof value === "boolean") return value;
	throw new Error(`${source}: expected boolean or null`);
}

function readStringArray(value: unknown, source: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${source}: expected array`);
	const entries = value.map((entry, index) => readString(entry, `${source}[${index}]`));
	if (new Set(entries).size !== entries.length) throw new Error(`${source}: duplicate value`);
	return entries;
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error(`${source}: expected object`);
}
