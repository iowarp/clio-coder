import type { EvalSuiteTargetV2, EvalSuiteV2 } from "../schema/suite.js";

export interface ResolveSuiteOptions {
	target?: string;
	model?: string;
	trials?: number;
}

export function resolveSuiteForRun(suite: EvalSuiteV2, options: ResolveSuiteOptions): EvalSuiteV2 {
	const targets = resolveTargets(suite.matrix.targets, options);
	return {
		...suite,
		matrix: {
			...suite.matrix,
			targets,
			...(options.trials === undefined ? {} : { repeats: options.trials }),
		},
	};
}

export function artifactMatrixIdentity(targets: ReadonlyArray<EvalSuiteTargetV2>): {
	target: string;
	model: string | null;
	thinking: string | null;
} {
	if (targets.length === 1) {
		const target = targets[0];
		return {
			target: target?.id ?? "unknown",
			model: target?.model ?? null,
			thinking: target?.thinking ?? null,
		};
	}
	return { target: "multiple", model: null, thinking: null };
}

function resolveTargets(targets: ReadonlyArray<EvalSuiteTargetV2>, options: ResolveSuiteOptions): EvalSuiteTargetV2[] {
	const filtered =
		options.target === undefined ? [...targets] : targets.filter((target) => target.id === options.target);
	const selected =
		filtered.length > 0
			? filtered
			: options.target === undefined
				? [...targets]
				: [
						{
							id: options.target,
							// A one-row suite still owns its thinking dimension when the CLI
							// substitutes the target/model pair. Dropping it silently changes
							// an off baseline into the target's configured default.
							...(targets.length === 1 && targets[0]?.thinking !== undefined ? { thinking: targets[0].thinking } : {}),
						},
					];
	return selected.map((target) => ({
		...target,
		...(options.model === undefined ? {} : { model: options.model }),
	}));
}
