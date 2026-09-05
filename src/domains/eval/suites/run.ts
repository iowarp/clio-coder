import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { namingCompatibilityEnvironment } from "../../../core/naming-compat.js";
import { resolveMetricAssertion } from "../compare/thresholds.js";
import { buildEvalExecutionEnvelopeV1, type EvalExecutionObservationV1 } from "../execution-provenance.js";
import { aggregateEvalVerdicts } from "../metrics/aggregate.js";
import { collectContextMetrics } from "../metrics/context.js";
import { fleetLoopReceiptAgreement } from "../metrics/fleet-loop-stream.js";
import {
	processInvariantMetrics,
	readRunJournal,
	receiptInvariantMetrics,
	receiptUsageMetrics,
	sessionInvariantMetrics,
	writeBoundaryInvariantMetrics,
} from "../metrics/invariants.js";
import { wallTimeMetric } from "../metrics/latency.js";
import { tokenAccountingFrom } from "../metrics/tokens.js";
import { zeroToolCallMetrics } from "../metrics/tool-calls.js";
import {
	buildEvalTrackedMetrics,
	emptyEvalTrackedMetrics,
	readEvalLedgerSnapshot,
	selectEvalLedgerEntries,
} from "../metrics/tracked.js";
import {
	type EvalServingObservation,
	evalClioProvenance,
	evalEnvironmentProvenance,
	evalServingConfiguration,
	evalServingObservationFrom,
} from "../provenance.js";
import { runClioRunRunner } from "../runners/clio-run.js";
import { runContextIndexRunner } from "../runners/context-index.js";
import { runContextInitRunner } from "../runners/context-init.js";
import { type EvalRunnerOutput, runExternalCommandRunner } from "../runners/external-command.js";
import { adaptSuiteV2ResultToBehaviorV1, adaptSuiteV2ResultToVerdictV1 } from "../schema/adapter.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../schema/artifact.js";
import { buildEvalBehaviorMetricsV1 } from "../schema/behavioral-metrics.js";
import { normalizeEvalSchemaId } from "../schema/naming.js";
import type { EvalServingConfigurationV1 } from "../schema/serving.js";
import type { EvalMetricAssertion, EvalSuiteTargetV2, LoadedEvalSuiteV2 } from "../schema/suite.js";
import { createEvalId } from "../store.js";
import { runCommandVerifiers } from "../verifiers/command.js";
import { forbiddenPathHits } from "../verifiers/file-exists.js";
import { collectPatchMetrics } from "../verifiers/patch.js";
import { prepareGitWorkspace } from "../workspaces/git.js";
import { type PreparedEvalWorkspace, prepareLocalWorkspace } from "../workspaces/local.js";
import { type PrepareTempCopyWorkspaceOptions, prepareTempCopyWorkspace } from "../workspaces/temp-copy.js";
import { expandEvalMatrix } from "./matrix.js";
import { artifactMatrixIdentity } from "./resolve.js";

class EvalWorkspaceSetupError extends Error {
	constructor(exitCode: number, stderr: string) {
		super(`workspace setup failed (exit ${exitCode}): ${stderr.trim()}`);
		this.name = "EvalWorkspaceSetupError";
	}
}

export interface RunEvalSuiteV2Options {
	clioEntry: string;
	now?: () => Date;
	/** Convert local workspaces into isolated copies for explicit trial runs. */
	freshWorkspaces?: boolean;
	/** Dependency/root seam for deterministic workspace lifecycle contracts. */
	tempCopy?: PrepareTempCopyWorkspaceOptions;
}

interface CompletedMatrixItem {
	result: EvalArtifactResultV4;
	serving: EvalServingObservation;
}

export async function runEvalSuiteV2(
	loaded: LoadedEvalSuiteV2,
	options: RunEvalSuiteV2Options,
): Promise<EvalArtifactV4> {
	const now = options.now ?? (() => new Date());
	const started = now();
	const evalId = createEvalId(started, loaded.hash);
	const results: EvalArtifactResultV4[] = [];
	const servingObservations: EvalServingObservation[] = [];
	const maxCostUsd = loaded.suite.matrix.maxCostUsd;
	let spentUsd = 0;
	for (const item of expandEvalMatrix(loaded.suite)) {
		// The cost ceiling bounds the whole matrix: once known receipt cost
		// exceeds it, remaining items fail closed instead of running. A live
		// suite can therefore never keep spending past its declared budget.
		if (maxCostUsd !== undefined && spentUsd > maxCostUsd) {
			results.push(budgetExhaustedResult(loaded, item.task, item.target, item.repeatIndex, spentUsd, maxCostUsd));
			continue;
		}
		const completed = await runMatrixItem(
			loaded,
			item.task,
			item.target,
			item.repeatIndex,
			options.clioEntry,
			options.freshWorkspaces === true,
			options.tempCopy,
		);
		spentUsd += resultCostUsd(completed.result);
		results.push(completed.result);
		servingObservations.push(completed.serving);
	}
	const serving = await evalServingConfiguration(loaded.suite.matrix.targets, servingObservations);
	return buildArtifact(loaded, evalId, results, options.clioEntry, serving);
}

/** Known receipt cost of one finished matrix item; unpriced runs count zero. */
function resultCostUsd(result: Pick<EvalArtifactResultV4, "metrics">): number {
	const value = result.metrics["cost.usd"];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function budgetExhaustedResult(
	loaded: LoadedEvalSuiteV2,
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	target: EvalSuiteTargetV2,
	repeatIndex: number,
	spentUsd: number,
	maxCostUsd: number,
): EvalArtifactResultV4 {
	const result: EvalArtifactResultV4 = {
		assignmentId: null,
		terminalReceiptDigest: null,
		taskId: task.id,
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
	result.verdict = adaptSuiteV2ResultToVerdictV1(result, emptyEvalTrackedMetrics());
	attachBehavioralResult(result, task);
	attachExecutionEnvelope(result, task, target, loaded.baseDir, null, emptyLedgerSnapshot());
	return result;
}

async function runMatrixItem(
	loaded: LoadedEvalSuiteV2,
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	target: EvalSuiteTargetV2,
	repeatIndex: number,
	clioEntry: string,
	freshWorkspace: boolean,
	tempCopy: PrepareTempCopyWorkspaceOptions | undefined,
): Promise<CompletedMatrixItem> {
	let workspace: PreparedEvalWorkspace | null = null;
	let receipt: EvalRunnerOutput["receipt"] = null;
	let runnerWallTimeMs = 0;
	let executionObservation: EvalExecutionObservationV1 | undefined;
	// One matrix item, one Clio journal. An item measures Clio, and a shared
	// state directory would mix sibling processes' runs and yesterday's sessions
	// into the reading; pinning it here also means an item leaves nothing behind
	// in the operator's own state.
	const stateDir = await mkdtemp(resolve(tempCopy?.tempRoot ?? tmpdir(), "clio-coder-eval-state-"));
	try {
		workspace = await prepareWorkspace(loaded.baseDir, task, freshWorkspace, tempCopy);
		const setup = await runCommandVerifiers(task.workspace.setup ?? [], workspace.dir, task.timeoutMs);
		// A fixture that never came up measured nothing, so the item fails as a
		// harness failure rather than reporting an invariant it never observed.
		if (!setup.pass) throw new EvalWorkspaceSetupError(setup.exitCode, setup.stderr);
		const runner = await runTaskRunner(task, target, workspace.dir, clioEntry, {
			CLIO_CODER_STATE_DIR: stateDir,
			CLIO_CODER_ENTRY: clioEntry,
		});
		const runnerStdoutFile = resolve(stateDir, "eval-runner-output.jsonl");
		await writeFile(runnerStdoutFile, runner.stdout, "utf8");
		receipt = runner.receipt ?? null;
		runnerWallTimeMs = runner.wallTimeMs;
		const patch = collectPatchMetrics(workspace.dir);
		const receiptExitCode = runner.exitCode;
		// Read after the runner returned and before the journal is removed: what
		// Clio sealed for this item, judged against its own ledger, and whether
		// the workers it attested are still running.
		const journalMetrics = invariantMetrics(stateDir, receiptExitCode);
		const measurement = await measureTaskOutcome(task, workspace.dir, {
			...namingCompatibilityEnvironment(
				"CLIO_CODER_EVAL_RUNNER_STDOUT_FILE",
				"CLIO_EVAL_RUNNER_STDOUT_FILE",
				runnerStdoutFile,
			),
		});
		executionObservation = measurement.executionObservation;
		const metrics: Record<string, number | string | boolean | null> = {
			...zeroToolCallMetrics(),
			...collectContextMetrics(workspace.dir),
			// A runner may have exact measurements from command output. Those win
			// over the generic post-run artifact collector.
			...runner.metrics,
			...journalMetrics,
			// The one reading that needs both sides: what the loop reported it
			// spent, and what the journal shows it sealed.
			...fleetLoopReceiptAgreement(runner.metrics as Record<string, number | boolean>, journalMetrics),
			"patch.bytes": patch.bytes,
			"patch.filesChanged": patch.filesChanged,
			"patch.testFilesModified": patch.testFilesModified,
			"result.pass": runner.exitCode === 0,
			"result.failureClass": runner.exitCode === 0 ? null : "runner_failed",
			...measurement.metrics,
		};
		const verifier = await runVerifiers(task, workspace.dir, metrics);
		const graderFailed = metrics["task.solved"] === false;
		const pass = runner.exitCode === 0 && verifier.pass && !graderFailed;
		const failureClass = pass
			? null
			: runner.exitCode !== 0
				? "runner_failed"
				: !verifier.pass
					? verifier.failureClass
					: "grader_failed";
		metrics["verifier.exitCode"] = verifier.exitCode;
		metrics["result.pass"] = pass;
		metrics["result.failureClass"] = failureClass;
		const result: EvalArtifactResultV4 = {
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
				workspace: workspace.dir,
				...(verifier.stdout.length > 0 ? { verifierStdout: verifier.stdout } : {}),
				...(verifier.stderr.length > 0 ? { verifierStderr: verifier.stderr } : {}),
			},
		};
		const snapshot = await readEvalLedgerSnapshot(stateDir);
		const selected = selectEvalLedgerEntries(snapshot.entries, runner.ledgerEntries ?? []);
		result.artifacts.trackedMetricSources = JSON.stringify({
			assistantCalls: selected.source,
			sessionCalls: selected.sessionCalls,
			streamCalls: selected.streamCalls,
			compactions: "session",
		});
		if (selected.sessionCalls > 0 && selected.streamCalls > 0) {
			// Preserve the unmerged evidence for opaque runners too. The native
			// runner already publishes this artifact before stdout truncation.
			result.artifacts.callLedger ??= JSON.stringify(runner.ledgerEntries);
			if (selected.sessionCalls !== selected.streamCalls || task.runner.kind === "external-command") {
				result.artifacts.trackedMetricWarning =
					"Session and stream call coverage may differ; tracked metrics use session calls, not a reconciled union. " +
					"Inspect callLedger before treating these counts as complete: no shared call identity proves overlap.";
			}
		}
		result.verdict = adaptSuiteV2ResultToVerdictV1(
			result,
			buildEvalTrackedMetrics({
				ledgerEntries: selected.entries,
				receipt: receipt ?? null,
				fallbackWallClockMs: runner.wallTimeMs,
			}),
		);
		attachBehavioralResult(result, task);
		attachExecutionEnvelope(result, task, target, workspace.dir, receipt ?? null, snapshot, executionObservation);
		return {
			result,
			serving: evalServingObservationFrom(target, receipt ?? null, snapshot.compiledPromptHashes),
		};
	} catch (error) {
		const failureClass = error instanceof EvalWorkspaceSetupError ? "setup_failed" : "command_error";
		const result: EvalArtifactResultV4 = {
			assignmentId: null,
			terminalReceiptDigest: null,
			taskId: task.id,
			repeatIndex,
			target: { id: target.id, model: target.model ?? null, thinking: target.thinking ?? null },
			pass: false,
			failureClass,
			metrics: {
				"result.pass": false,
				"result.failureClass": failureClass,
				"verifier.exitCode": 1,
				"latency.wallMs": 0,
			},
			artifacts: {
				error: error instanceof Error ? error.message : String(error),
				...(workspace === null ? {} : { workspace: workspace.dir }),
			},
		};
		const snapshot = await readEvalLedgerSnapshot(stateDir);
		result.verdict = adaptSuiteV2ResultToVerdictV1(
			result,
			buildEvalTrackedMetrics({
				ledgerEntries: snapshot.entries,
				receipt: receipt ?? null,
				fallbackWallClockMs: runnerWallTimeMs,
			}),
		);
		attachBehavioralResult(result, task);
		attachExecutionEnvelope(
			result,
			task,
			target,
			workspace?.dir ?? loaded.baseDir,
			receipt ?? null,
			snapshot,
			executionObservation,
		);
		return {
			result,
			serving: evalServingObservationFrom(target, receipt ?? null, snapshot.compiledPromptHashes),
		};
	} finally {
		try {
			await workspace?.cleanup();
		} finally {
			// A workspace cleanup error must not strand the suite-owned journal.
			await rm(stateDir, { recursive: true, force: true });
		}
	}
}

function attachBehavioralResult(result: EvalArtifactResultV4, task: LoadedEvalSuiteV2["suite"]["tasks"][number]): void {
	if (task.behavioral === undefined || result.verdict === undefined) return;
	result.behavioral = adaptSuiteV2ResultToBehaviorV1(result, result.verdict, task.behavioral);
	result.behavioralMetrics = buildEvalBehaviorMetricsV1(result, task.behavioral.execution.subject.role);
}

function attachExecutionEnvelope(
	result: EvalArtifactResultV4,
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	target: EvalSuiteTargetV2,
	cwd: string | null,
	receipt: NonNullable<EvalRunnerOutput["receipt"]> | null,
	ledger: Awaited<ReturnType<typeof readEvalLedgerSnapshot>>,
	observation?: EvalExecutionObservationV1,
): void {
	if (task.behavioral === undefined) return;
	result.executionEnvelope = buildEvalExecutionEnvelopeV1({
		task,
		target,
		cwd,
		receipt,
		ledger,
		...(observation === undefined ? {} : { observation }),
	});
}

function emptyLedgerSnapshot(): Awaited<ReturnType<typeof readEvalLedgerSnapshot>> {
	return { entries: [], compiledPromptHashes: [], promptManifests: [], contextSnapshots: [] };
}

/** Journal-derived invariants for one finished item, read from its isolated state directory. */
function invariantMetrics(stateDir: string, runnerExitCode: number): Record<string, number | boolean> {
	const journal = readRunJournal(stateDir);
	return {
		...receiptInvariantMetrics(journal, runnerExitCode),
		...receiptUsageMetrics(journal),
		...sessionInvariantMetrics(stateDir),
		...processInvariantMetrics(journal),
		...writeBoundaryInvariantMetrics(stateDir),
	};
}

async function prepareWorkspace(
	baseDir: string,
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	freshWorkspace: boolean,
	tempCopy: PrepareTempCopyWorkspaceOptions | undefined,
): Promise<PreparedEvalWorkspace> {
	if (task.workspace.kind === "local" && freshWorkspace) {
		return prepareTempCopyWorkspace(baseDir, { ...task.workspace, kind: "temp-copy" }, tempCopy);
	}
	if (task.workspace.kind === "local") return prepareLocalWorkspace(baseDir, task.workspace);
	if (task.workspace.kind === "git") return prepareGitWorkspace(task.workspace);
	return prepareTempCopyWorkspace(baseDir, task.workspace, tempCopy);
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
	return runClioRunRunner(task.runner, cwd, clioEntry, task.timeoutMs, target, env, task.metrics.readObservation);
}

/**
 * Run the task-outcome grader and report what it found. A nonzero exit is
 * recorded rather than thrown so the verdict can report a failed outcome with
 * healthy machinery. A task that declares no measure commands reports nothing
 * and leaves its final pass decision to the runner and gating verifiers.
 */
async function measureTaskOutcome(
	task: LoadedEvalSuiteV2["suite"]["tasks"][number],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<{ metrics: Record<string, number | boolean>; executionObservation?: EvalExecutionObservationV1 }> {
	const commands = task.verify.measure ?? [];
	if (commands.length === 0) return { metrics: {} };
	const result = await runCommandVerifiers(commands, cwd, task.timeoutMs, env);
	const behavioral = graderBehaviorMeasurement(result.stdout);
	return {
		metrics: {
			"task.exitCode": result.exitCode,
			"task.solved": result.exitCode === 0,
			...behavioral.metrics,
		},
		...(behavioral.executionObservation === undefined ? {} : { executionObservation: behavioral.executionObservation }),
	};
}

function graderBehaviorMeasurement(stdout: string): {
	metrics: Record<string, number | boolean>;
	executionObservation?: EvalExecutionObservationV1;
} {
	const metrics: Record<string, number | boolean> = {};
	let executionObservation: EvalExecutionObservationV1 | undefined;
	for (const line of stdout.split(/\r?\n/u)) {
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch {
			continue;
		}
		if (!isRecord(value)) continue;
		if (normalizeEvalSchemaId(value.schema) === "clio-coder.eval.measure.v1" && isRecord(value.metrics)) {
			for (const [key, metric] of Object.entries(value.metrics)) {
				if (key !== "claims.unsupported" && key !== "completion.reported") continue;
				if (typeof metric === "boolean" || (typeof metric === "number" && Number.isFinite(metric))) metrics[key] = metric;
			}
		}
		if (normalizeEvalSchemaId(value.schema) === "clio-coder.eval.execution-observation.v1") {
			executionObservation = parseExecutionObservation(value);
		}
	}
	return { metrics, ...(executionObservation === undefined ? {} : { executionObservation }) };
}

function parseExecutionObservation(value: Record<string, unknown>): EvalExecutionObservationV1 {
	const policies = isRecord(value.policyHashes) ? value.policyHashes : {};
	const project = isRecord(value.projectContext) ? value.projectContext : null;
	return {
		compositionHash: nullableDigest(value.compositionHash),
		target: nullableString(value.target),
		wireModel: nullableString(value.wireModel),
		runtime: nullableString(value.runtime),
		thinkingLevel: nullableString(value.thinkingLevel),
		toolSignature: nullableDigest(value.toolSignature),
		autonomy: nullableString(value.autonomy),
		policyHashes: { rulePack: nullableDigest(policies.rulePack), project: nullableDigest(policies.project) },
		projectContext:
			project === null
				? null
				: {
						tier: nullableString(project.tier),
						contentHash: nullableDigest(project.contentHash),
						chars: nullableNonNegativeInteger(project.chars),
						sections: stringArray(project.sections),
						rulesApplied: stringArray(project.rulesApplied),
						operatorProfileApplied:
							typeof project.operatorProfileApplied === "boolean" ? project.operatorProfileApplied : null,
					},
	};
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
	servingConfiguration: EvalServingConfigurationV1,
): EvalArtifactV4 {
	const passed = results.filter((result) => result.pass).length;
	return {
		version: 4,
		evalId,
		suite: { id: loaded.suite.suite.id, hash: loaded.hash },
		clioCoder: evalClioProvenance({ entry: clioEntry }),
		environment: evalEnvironmentProvenance(),
		matrix: {
			...artifactMatrixIdentity(loaded.suite.matrix.targets),
			...(loaded.suite.matrix.dimensions === undefined ? {} : { dimensions: loaded.suite.matrix.dimensions }),
		},
		servingConfiguration,
		summary: {
			runs: results.length,
			passed,
			failed: results.length - passed,
			passRate: results.length === 0 ? 0 : passed / results.length,
			tokens: tokenAccountingFrom(results),
			wallTimeMs: results.reduce((sum, result) => sum + wallTimeMetric(result.metrics), 0),
		},
		aggregates: aggregateEvalVerdicts(
			results.flatMap((result) => (result.verdict === undefined ? [] : [result.verdict])),
		),
		results,
	};
}

function assertionMessage(assertion: EvalMetricAssertion, actual: number | string | boolean | null): string {
	return `assertion failed: ${assertion.metric} ${assertion.op} ${String(assertion.value)} (actual ${JSON.stringify(actual)})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableDigest(value: unknown): string | null {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function nullableNonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
