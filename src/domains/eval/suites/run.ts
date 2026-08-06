import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveMetricAssertion } from "../compare/thresholds.js";
import { collectContextMetrics } from "../metrics/context.js";
import { readRunJournal, receiptInvariantMetrics } from "../metrics/invariants.js";
import { wallTimeMetric } from "../metrics/latency.js";
import { tokenAccountingFrom } from "../metrics/tokens.js";
import { zeroToolCallMetrics } from "../metrics/tool-calls.js";
import { evalClioProvenance, evalEnvironmentProvenance } from "../provenance.js";
import { runClioRunRunner } from "../runners/clio-run.js";
import { runContextIndexRunner } from "../runners/context-index.js";
import { runContextInitRunner } from "../runners/context-init.js";
import { type EvalRunnerOutput, runExternalCommandRunner } from "../runners/external-command.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../schema/artifact.js";
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
): Promise<EvalArtifactV4> {
	const now = options.now ?? (() => new Date());
	const started = now();
	const evalId = createEvalId(started, loaded.hash);
	const results: EvalArtifactResultV4[] = [];
	const maxCostUsd = loaded.suite.matrix.maxCostUsd;
	let spentUsd = 0;
	for (const item of expandEvalMatrix(loaded.suite)) {
		// The cost ceiling bounds the whole matrix: once known receipt cost
		// exceeds it, remaining items fail closed instead of running. A live
		// suite can therefore never keep spending past its declared budget.
		if (maxCostUsd !== undefined && spentUsd > maxCostUsd) {
			results.push(budgetExhaustedResult(item.task.id, item.target, item.repeatIndex, spentUsd, maxCostUsd));
			continue;
		}
		const result = await runMatrixItem(loaded, item.task, item.target, item.repeatIndex, options.clioEntry);
		spentUsd += resultCostUsd(result);
		results.push(result);
	}
	return buildArtifact(loaded, evalId, results, options.clioEntry);
}

/** Known receipt cost of one finished matrix item; unpriced runs count zero. */
export function resultCostUsd(result: Pick<EvalArtifactResultV4, "metrics">): number {
	const value = result.metrics["cost.usd"];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function budgetExhaustedResult(
	taskId: string,
	target: EvalSuiteTargetV2,
	repeatIndex: number,
	spentUsd: number,
	maxCostUsd: number,
): EvalArtifactResultV4 {
	return {
		assignmentId: null,
		terminalReceiptDigest: null,
		taskId,
		repeatIndex,
		target: { id: target.id, model: target.model ?? null, thinking: target.thinking ?? null },
		pass: false,
		failureClass: "budget_exhausted",
		metrics: {
			"result.pass": false,
			"result.failureClass": "budget_exhausted",
			"verifier.exitCode": 1,
			"latency.wallMs": 0,
		},
		artifacts: {
			error: `matrix cost budget exhausted: spent $${spentUsd.toFixed(4)} of max $${maxCostUsd.toFixed(4)} before this item`,
		},
	};
}

async function runMatrixItem(
	loaded: LoadedEvalSuiteV2,
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	target: EvalSuiteTargetV2,
	repeatIndex: number,
	clioEntry: string,
): Promise<EvalArtifactResultV4> {
	let workspace: PreparedEvalWorkspace | null = null;
	// One matrix item, one Clio journal. An item measures Clio, and a shared
	// state directory would mix sibling processes' runs and yesterday's sessions
	// into the reading; pinning it here also means an item leaves nothing behind
	// in the operator's own state.
	const stateDir = await mkdtemp(resolve(tmpdir(), "clio-eval-state-"));
	try {
		workspace = await prepareWorkspace(loaded.baseDir, task);
		const runner = await runTaskRunner(task, target, workspace.dir, clioEntry, { CLIO_STATE_DIR: stateDir });
		const patch = collectPatchMetrics(workspace.dir);
		const metrics: Record<string, number | string | boolean | null> = {
			...zeroToolCallMetrics(),
			...collectContextMetrics(workspace.dir),
			// A runner may have exact measurements from command output. Those win
			// over the generic post-run artifact collector.
			...runner.metrics,
			// Read after the runner returned and before the journal is removed:
			// what Clio sealed for this item, judged against its own ledger.
			...receiptInvariantMetrics(readRunJournal(stateDir), runner.exitCode),
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
			assignmentId: runner.assignmentId,
			terminalReceiptDigest: runner.terminalReceiptDigest,
			taskId: task.id,
			repeatIndex,
			target: { id: target.id, model: target.model ?? null, thinking: target.thinking ?? null },
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
			assignmentId: null,
			terminalReceiptDigest: null,
			taskId: task.id,
			repeatIndex,
			target: { id: target.id, model: target.model ?? null, thinking: target.thinking ?? null },
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
		await rm(stateDir, { recursive: true, force: true });
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
	env: NodeJS.ProcessEnv,
): Promise<EvalRunnerOutput> {
	if (task.runner.kind === "external-command") return runExternalCommandRunner(task.runner, cwd, task.timeoutMs, env);
	if (task.runner.kind === "context-index") return runContextIndexRunner(cwd, clioEntry, task.timeoutMs, target, env);
	if (task.runner.kind === "context-init")
		return runContextInitRunner(task.runner, cwd, clioEntry, task.timeoutMs, target, env);
	return runClioRunRunner(task.runner, cwd, clioEntry, task.timeoutMs, target, env);
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
	// An assertion whose metric this run could not produce fails closed. A check
	// that silently passes because it never ran is worse than no check: it
	// reports compliance it never observed.
	for (const assertion of task.verify.assertions ?? []) {
		const resolution = resolveMetricAssertion(assertion, metrics);
		if (!resolution.unresolved && resolution.holds) continue;
		return {
			pass: false,
			exitCode: 1,
			failureClass: resolution.unresolved ? "assertion_unresolved" : "assertion_failed",
			stdout: "",
			stderr: resolution.unresolved
				? `assertion unresolved (fail closed): ${assertion.metric} was not measured by this run`
				: assertionMessage(assertion, resolution.actual),
		};
	}
	return { pass: true, exitCode: 0, failureClass: null, stdout: commandResult.stdout, stderr: commandResult.stderr };
}

function buildArtifact(
	loaded: LoadedEvalSuiteV2,
	evalId: string,
	results: EvalArtifactResultV4[],
	clioEntry: string,
): EvalArtifactV4 {
	const passed = results.filter((result) => result.pass).length;
	return {
		version: 4,
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
			tokens: tokenAccountingFrom(results),
			wallTimeMs: results.reduce((sum, result) => sum + wallTimeMetric(result.metrics), 0),
		},
		results,
	};
}

function assertionMessage(assertion: EvalMetricAssertion, actual: number | string | boolean | null): string {
	return `assertion failed: ${assertion.metric} ${assertion.op} ${String(assertion.value)} (actual ${JSON.stringify(actual)})`;
}
