import type { EvalSuiteTargetV2, EvalSuiteTaskV2, EvalSuiteV2 } from "../schema/suite.js";

export interface EvalMatrixRun {
	task: EvalSuiteTaskV2;
	target: EvalSuiteTargetV2;
	repeatIndex: number;
}

export function expandEvalMatrix(suite: EvalSuiteV2): EvalMatrixRun[] {
	const runs: EvalMatrixRun[] = [];
	for (let repeatIndex = 0; repeatIndex < suite.matrix.repeats; repeatIndex += 1) {
		for (const target of suite.matrix.targets) {
			for (const task of suite.tasks) {
				runs.push({ task, target, repeatIndex });
			}
		}
	}
	return runs;
}
