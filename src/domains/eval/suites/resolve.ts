import type { EvalSuiteTargetV2, EvalSuiteV2 } from "../schema/suite-v2.js";

export interface ResolveSuiteOptions {
	target?: string;
	model?: string;
}

export function resolveSuiteForRun(suite: EvalSuiteV2, options: ResolveSuiteOptions): EvalSuiteV2 {
	const targets = resolveTargets(suite.matrix.targets, options);
	return {
		...suite,
		matrix: {
			...suite.matrix,
			targets,
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
		filtered.length > 0 ? filtered : options.target === undefined ? [...targets] : [{ id: options.target }];
	return selected.map((target) => ({
		...target,
		...(options.model === undefined ? {} : { model: options.model }),
	}));
}
