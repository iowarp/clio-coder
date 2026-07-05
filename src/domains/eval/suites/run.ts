import { evaluateMetricAssertion } from "../compare/thresholds.js";
import { collectContextMetrics } from "../metrics/context.js";
import { wallTimeMetric } from "../metrics/latency.js";
import { addTokenMetrics, tokenMetricsFrom, zeroTokenMetrics } from "../metrics/tokens.js";
import { zeroToolCallMetrics } from "../metrics/tool-calls.js";
import { evalClioProvenance, evalEnvironmentProvenance } from "../provenance.js";
import { runClioRunRunner } from "../runners/clio-run.js";
import { runContextIndexRunner } from "../runners/context-index.js";
import { runContextInitRunner } from "../runners/context-init.js";
import { type EvalRunnerOutput, runExternalCommandRunner } from "../runners/external-command.js";
import type { EvalArtifactResultV2, EvalArtifactV2 } from "../schema/artifact.js";
import type { EvalMetricAssertion, EvalSuiteTargetV2, LoadedEvalSuiteV2 } from "../schema/suite.js";
import { createEvalId } from "../store.js";
import { runCommandVerifiers } from "../verifiers/command.js";
import { forbiddenPathHits } from "../verifiers/file-exists.js";
import { collectPatchMetrics } from "../verifiers/patch.js";
import { prepareGitWorkspace } from "../workspaces/git.js";
import { type PreparedEvalWorkspace, prepareLocalWorkspace } from "../workspaces/local.js";
import { prepareTempCopyWorkspace } from "../workspaces/temp-copy.js";
import { expandEvalMatrix } from "./matrix.js";
import { artifactMatrixIdentity } from "./resolve.js";

export interface RunEvalSuiteV2Options {
	clioEntry: string;
	now?: () => Date;
}

export async function runEvalSuiteV2(
	loaded: LoadedEvalSuiteV2,
	options: RunEvalSuiteV2Options,
): Promise<EvalArtifactV2> {
	const now = options.now ?? (() => new Date());
	const started = now();
	const evalId = createEvalId(started, loaded.hash);
	const results: EvalArtifactResultV2[] = [];
	for (const item of expandEvalMatrix(loaded.suite)) {
		results.push(await runMatrixItem(loaded, item.task, item.target, item.repeatIndex, options.clioEntry));
	}
	return buildArtifact(loaded, evalId, results, options.clioEntry);
}

async function runMatrixItem(
	loaded: LoadedEvalSuiteV2,
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	target: EvalSuiteTargetV2,
	repeatIndex: number,
	clioEntry: string,
): Promise<EvalArtifactResultV2> {
	let workspace: PreparedEvalWorkspace | null = null;
	try {
		workspace = await prepareWorkspace(loaded.baseDir, task);
		const runner = await runTaskRunner(task, target, workspace.dir, clioEntry);
		const patch = collectPatchMetrics(workspace.dir);
		const metrics: Record<string, number | string | boolean | null> = {
			...zeroToolCallMetrics(),
			...runner.metrics,
			...collectContextMetrics(workspace.dir),
			"patch.bytes": patch.bytes,
			"patch.filesChanged": patch.filesChanged,
			"patch.testFilesModified": patch.testFilesModified,
			"result.pass": runner.exitCode === 0,
			"result.failureClass": runner.exitCode === 0 ? null : "runner_failed",
		};
		const verifier = await runVerifiers(task, workspace.dir, metrics);
		const pass = runner.exitCode === 0 && verifier.pass;
		const failureClass = pass ? null : runner.exitCode !== 0 ? "runner_failed" : verifier.failureClass;
		metrics["verifier.exitCode"] = verifier.exitCode;
		metrics["result.pass"] = pass;
		metrics["result.failureClass"] = failureClass;
		return {
			taskId: task.id,
			repeatIndex,
			pass,
			failureClass,
			metrics,
			artifacts: {
				...runner.artifacts,
				...(verifier.stdout.length > 0 ? { verifierStdout: verifier.stdout } : {}),
				...(verifier.stderr.length > 0 ? { verifierStderr: verifier.stderr } : {}),
			},
		};
	} catch (error) {
		return {
			taskId: task.id,
			repeatIndex,
			pass: false,
			failureClass: "command_error",
			metrics: {
				"result.pass": false,
				"result.failureClass": "command_error",
				"verifier.exitCode": 1,
				"latency.wallMs": 0,
			},
			artifacts: { error: error instanceof Error ? error.message : String(error) },
		};
	} finally {
		await workspace?.cleanup();
	}
}

async function prepareWorkspace(
	baseDir: string,
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
): Promise<PreparedEvalWorkspace> {
	if (task.workspace.kind === "local") return prepareLocalWorkspace(baseDir, task.workspace);
	if (task.workspace.kind === "git") return prepareGitWorkspace(task.workspace);
	return prepareTempCopyWorkspace(baseDir, task.workspace);
}

async function runTaskRunner(
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	target: EvalSuiteTargetV2,
	cwd: string,
	clioEntry: string,
): Promise<EvalRunnerOutput> {
	if (task.runner.kind === "external-command") return runExternalCommandRunner(task.runner, cwd, task.timeoutMs);
	if (task.runner.kind === "context-index") return runContextIndexRunner(cwd, clioEntry, task.timeoutMs, target);
	if (task.runner.kind === "context-init") return runContextInitRunner(cwd, clioEntry, task.timeoutMs);
	return runClioRunRunner(task.runner, cwd, clioEntry, task.timeoutMs, target);
}

async function runVerifiers(
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	cwd: string,
	metrics: Record<string, number | string | boolean | null>,
): Promise<{ pass: boolean; exitCode: number; failureClass: string | null; stdout: string; stderr: string }> {
	const commandResult = await runCommandVerifiers(task.verify.commands ?? [], cwd, task.timeoutMs);
	if (!commandResult.pass) {
		return {
			pass: false,
			exitCode: commandResult.exitCode,
			failureClass: "verifier_failed",
			stdout: commandResult.stdout,
			stderr: commandResult.stderr,
		};
	}
	const forbidden = forbiddenPathHits(cwd, task.verify.forbidPaths ?? []);
	if (forbidden.length > 0) {
		return {
			pass: false,
			exitCode: 1,
			failureClass: "forbidden_path",
			stdout: "",
			stderr: `forbidden paths exist: ${forbidden.join(", ")}`,
		};
	}
	const failedAssertion = (task.verify.assertions ?? []).find(
		(assertion) => !evaluateMetricAssertion(assertion, metrics),
	);
	if (failedAssertion !== undefined) {
		return {
			pass: false,
			exitCode: 1,
			failureClass: "assertion_failed",
			stdout: "",
			stderr: assertionMessage(failedAssertion),
		};
	}
	return { pass: true, exitCode: 0, failureClass: null, stdout: commandResult.stdout, stderr: commandResult.stderr };
}

function buildArtifact(
	loaded: LoadedEvalSuiteV2,
	evalId: string,
	results: EvalArtifactResultV2[],
	clioEntry: string,
): EvalArtifactV2 {
	const passed = results.filter((result) => result.pass).length;
	const tokenTotals = results.reduce(
		(total, result) => addTokenMetrics(total, tokenMetricsFrom(result.metrics)),
		zeroTokenMetrics(),
	);
	return {
		version: 2,
		evalId,
		suite: { id: loaded.suite.suite.id, hash: loaded.hash },
		clio: evalClioProvenance({ entry: clioEntry }),
		environment: evalEnvironmentProvenance(),
		matrix: artifactMatrixIdentity(loaded.suite.matrix.targets),
		summary: {
			runs: results.length,
			passed,
			failed: results.length - passed,
			passRate: results.length === 0 ? 0 : passed / results.length,
			tokens: tokenTotals,
			wallTimeMs: results.reduce((sum, result) => sum + wallTimeMetric(result.metrics), 0),
		},
		results,
	};
}

function assertionMessage(assertion: EvalMetricAssertion): string {
	return `assertion failed: ${assertion.metric} ${assertion.op} ${String(assertion.value)}`;
}
