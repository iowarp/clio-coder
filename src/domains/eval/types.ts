export const EVAL_TASK_FILE_VERSION = 1;
export const EVAL_ARTIFACT_VERSION = 1;

export type EvalCommandPhase = "setup" | "verifier";

export type EvalFailureClass = "setup_failed" | "verifier_failed" | "timeout" | "cwd_missing" | "command_error";

export interface EvalTask {
	id: string;
	prompt: string;
	cwd: string;
	setup: string[];
	verifier: string[];
	timeoutMs: number;
	tags: string[];
}

export interface EvalTaskFile {
	version: 1;
	tasks: EvalTask[];
}

export interface EvalValidationIssue {
	path: string;
	message: string;
}

export type EvalTaskFileValidationResult =
	| { valid: true; taskFile: EvalTaskFile }
	| { valid: false; issues: EvalValidationIssue[] };

export interface LoadedEvalTaskFile {
	path: string;
	baseDir: string;
	contentHash: string;
	taskFile: EvalTaskFile;
}

export interface EvalCommandResult {
	phase: EvalCommandPhase;
	index: number;
	command: string;
	exitCode: number;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	wallTimeMs: number;
	stdout: string;
	stderr: string;
}

export interface EvalResult {
	taskId: string;
	runId: string;
	pass: boolean;
	exitCode: number;
	tokens: number;
	costUsd: number;
	wallTimeMs: number;
	failureClass?: EvalFailureClass;
	receiptPath?: string;
	evidenceId?: string;
}

export interface EvalRunRecord extends EvalResult {
	repeatIndex: number;
	cwd: string;
	prompt: string;
	tags: string[];
	commands: EvalCommandResult[];
}

export interface EvalFailureClassCount {
	failureClass: EvalFailureClass;
	count: number;
}

export interface EvalSummary {
	runs: number;
	passed: number;
	failed: number;
	passRate: number;
	tokens: number;
	costUsd: number;
	wallTimeMs: number;
	failureClasses: EvalFailureClassCount[];
}

export interface EvalRunArtifact {
	version: 1;
	evalId: string;
	taskFile: string;
	taskFileHash: string;
	repeat: number;
	startedAt: string;
	endedAt: string;
	summary: EvalSummary;
	results: EvalRunRecord[];
}
