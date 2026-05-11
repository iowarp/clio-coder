export interface ValidateModelInput {
	runtimeId: string;
	modelId: string;
	knownModels: ReadonlyArray<string>;
	force: boolean;
}

export type ValidateModelResult =
	| { ok: true; warning?: string }
	| { ok: false; reason: string; knownModels: ReadonlyArray<string> };

export function validateModelChoice(input: ValidateModelInput): ValidateModelResult {
	const { runtimeId, modelId, knownModels, force } = input;
	if (knownModels.length === 0) return { ok: true };
	if (knownModels.includes(modelId)) return { ok: true };
	if (force) {
		return {
			ok: true,
			warning: `model '${modelId}' not in ${runtimeId} catalog (use without --force to reject)`,
		};
	}
	const sample = knownModels.slice(0, 10).join(", ");
	return {
		ok: false,
		reason: `model '${modelId}' not in ${runtimeId} catalog. Known: ${sample}. Use --force to skip validation.`,
		knownModels: knownModels.slice(0, 10),
	};
}
