import {
	type GradeContract,
	type GradeFacts,
	type GradeVerdict,
	grade,
	type WorkFacts,
} from "../../src/domains/dispatch/grading.js";

/** A builder owing change-or-declared, on an observed tool lane, with a mutation report. */
export const BUILDER_GRADE: GradeContract = {
	role: "builder",
	obligation: "change-or-declared",
	contractKind: "mutation-report",
	toolLaneObserved: true,
};

/** Facts of a run that exited cleanly with a conforming answer; a test overrides the stage it is about. */
export function cleanGradeFacts(overrides: Partial<GradeFacts> = {}, work: Partial<WorkFacts> = {}): GradeFacts {
	return {
		termination: { outcome: "succeeded", detail: null },
		workerCode: { code: null },
		finishGateEngaged: false,
		blockedWrites: null,
		handback: { finalOutput: true, resultContract: { conformance: "pass", reason: null } },
		work: {
			activity: { executed: 1, observations: 1, mutatingSucceeded: false, storeWritten: false },
			mutatedPathCount: 0,
			blockedStateChanging: 0,
			escalations: { denied: 0, timedOut: 0 },
			recordedLimitations: [],
			writeRootRequest: null,
			completion: null,
			ungroundedChecks: [],
			gateVerdict: null,
			...work,
		},
		...overrides,
	};
}

/** Grade a run from clean facts with its work stage overridden. */
export function gradeWork(work: Partial<WorkFacts>, contract: GradeContract = BUILDER_GRADE): GradeVerdict {
	return grade(contract, cleanGradeFacts({}, work));
}
