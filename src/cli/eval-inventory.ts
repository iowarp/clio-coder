/**
 * Fixed machine-readable projection of the eval reports this installation stored.
 *
 * Neither existing read works as a transport. `eval report <evalId>` and
 * `eval compare <a> <b>` both require the operator to already name the reports
 * they want, and nothing enumerated the store, so a GUI host had nowhere to
 * start. This command accepts no identifier, no path, and no limit; it selects
 * a bounded newest-first window itself and emits each report's identity,
 * provenance, serving facts, accounting, and per-scenario outcome counts.
 *
 * An eval artifact is the largest single host-only payload in this harness, and
 * the reason is worth stating rather than discovering. `results[].artifacts`
 * holds whatever the runner attached, which for the `clio-run` runner is the
 * entire session transcript: the operator's task text, every tool argument and
 * result, the model's replies, provider endpoint URLs, error prose, and the
 * prepared workspace path. There is no width at which a projection of that is
 * safe, so it does not cross at any width and its per-report count crosses
 * instead. That is the same class as a trace event's payload and a process
 * command line, and it is why this read is a summary rather than a viewer.
 *
 * Held back for the same reason or the next one down: the eval entry path, the
 * per-result metric map (open-keyed, and its string values include content
 * hashes and a workspace's own structural digest), the compiled prompt hash,
 * the suite hash, the terminal receipt digests, and the behavioral judge's
 * facts and excerpts. What crosses instead is how many of each there are, and
 * the closed vocabularies the harness mints itself.
 */

import { clioDataDir } from "../core/xdg.js";
import { listEvalReports } from "../domains/eval/inventory.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../domains/eval/schema/artifact.js";
import { EVAL_EXECUTION_MATRIX_DIMENSIONS_V1 } from "../domains/eval/schema/execution-envelope.js";
import { evalServingConfigurationOf, sameEvalServingConfiguration } from "../domains/eval/schema/serving.js";
import { CANONICAL_METRIC_PREFIXES, CANONICAL_METRICS } from "../domains/eval/schema/suite.js";

/** Wire bound on the report window. */
export const EVAL_INVENTORY_MAX_REPORTS = 8;
/** Wire bound on each report's per-scenario roll-up. */
export const EVAL_INVENTORY_MAX_SCENARIOS = 16;

/**
 * Every failure class the suite runner mints, and nothing else.
 *
 * The legacy v1 runner also has `timeout` and `cwd_missing`, and they are
 * deliberately absent: routing accepts artifact v4 only, so this read can never
 * emit them and carrying them would state a distinction it never establishes.
 */
const FAILURE_CLASSES = [
	"budget_exhausted",
	"runner_failed",
	"grader_failed",
	"verifier_failed",
	"forbidden_path",
	"assertion_unresolved",
	"assertion_failed",
	"setup_failed",
	"command_error",
] as const;

/** A class outside the set is a real answer: the result still failed, and the operator still learns that. */
type EvalInventoryFailureClass = (typeof FAILURE_CLASSES)[number] | "other";

const REPORTED_FAILURE_CLASSES: readonly EvalInventoryFailureClass[] = [...FAILURE_CLASSES, "other"];

const BEHAVIOR_OUTCOMES = ["pass", "behavioral_failure", "unknown", "unmeasured", "infrastructure_failure"] as const;
type EvalInventoryBehaviorOutcome = (typeof BEHAVIOR_OUTCOMES)[number];

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;

export interface EvalInventoryTokens {
	/** False when no run reported provider usage. The counts are then absent rather than zero. */
	readonly measured: boolean;
	readonly runs: number;
	readonly measuredRuns: number;
	readonly input: number | null;
	readonly output: number | null;
	readonly total: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite: number | null;
}

export interface EvalInventoryScenario {
	readonly scenarioId: string;
	readonly trials: number;
	readonly passed: number;
	readonly failed: number;
	readonly unmeasured: number;
	readonly machineryFailures: number;
	readonly passAtK: number;
	readonly passPowK: number;
}

export interface EvalInventoryReport {
	readonly evalId: string;
	readonly startedAt: string | null;
	readonly suiteId: string;
	/**
	 * A 1-based ordinal over `sameEvalServingConfiguration`, the rule `eval
	 * compare` itself uses to decide two runs are comparable.
	 *
	 * The fields that rule compares include the compiled prompt hash, which is a
	 * fingerprint and does not cross. The relation it establishes does: two
	 * reports sharing an ordinal are two `eval compare` will accept without
	 * `--allow-config-drift`, which is the fact an operator picking a baseline
	 * needs, and the ordinal reveals nothing about the values behind it.
	 */
	readonly servingGroup: number;
	readonly clioVersion: string | null;
	readonly clioCommit: string | null;
	readonly platform: string | null;
	readonly node: string | null;
	readonly matrix: {
		readonly target: string | null;
		readonly model: string | null;
		readonly thinking: string | null;
		readonly dimensions: readonly string[];
	};
	readonly serving: {
		/** False when the artifact recorded none and the matrix it declared is standing in. */
		readonly observed: boolean;
		readonly targetId: string | null;
		readonly runtimeId: string | null;
		readonly modelId: string | null;
		readonly serverBuild: string | null;
		readonly thinkingLevel: string | null;
		readonly totalSlots: number | null;
		/** Whether a compiled prompt hash was recorded. The hash itself stays on the host. */
		readonly compiledPromptPinned: boolean;
	};
	readonly summary: {
		readonly runs: number;
		readonly passed: number;
		readonly failed: number;
		readonly passRate: number;
		readonly wallTimeMs: number;
		readonly tokens: EvalInventoryTokens;
	};
	readonly results: {
		readonly total: number;
		readonly withAssignment: number;
		readonly withTerminalReceipt: number;
		readonly withVerdict: number;
		readonly withBehavioral: number;
		readonly withExecutionEnvelope: number;
		readonly machineryFailures: number;
		/** Runner attachments across the report. Their contents are host-only at any width. */
		readonly attachments: number;
		/** Metric readings whose name the suite schema declares, and readings whose name it does not. */
		readonly canonicalMetrics: number;
		readonly otherMetrics: number;
	};
	readonly failureClasses: readonly { readonly failureClass: EvalInventoryFailureClass; readonly count: number }[];
	readonly behaviorOutcomes: readonly {
		readonly outcome: EvalInventoryBehaviorOutcome;
		readonly count: number;
	}[];
	/** Null when the artifact carried no scenario reductions at all, which is not the same as carrying none. */
	readonly scenarios: readonly EvalInventoryScenario[] | null;
	readonly scenariosTruncated: boolean;
	/** Reductions refused because their own counts did not add up, counted rather than hidden. */
	readonly scenariosDropped: number;
}

export interface EvalInventorySnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly available: boolean;
	readonly stored: number;
	readonly unreadable: number;
	readonly reports: readonly EvalInventoryReport[];
	readonly truncated: boolean;
}

const CANONICAL_METRIC_NAMES: ReadonlySet<string> = new Set(CANONICAL_METRICS);

function isCanonicalMetric(name: string): boolean {
	return CANONICAL_METRIC_NAMES.has(name) || CANONICAL_METRIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function identifier(value: string | null): string | null {
	return value !== null && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function tally(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `parseEvalArtifactV4` casts the aggregates array through without checking its
 * entries, so this is the first thing that looks at them. A scenario whose id
 * or counts are not what the reducer produces is dropped rather than repaired:
 * a scenario roll-up is a derived number, and a wrong one is worse than a
 * missing one.
 */
function projectScenarios(artifact: EvalArtifactV4): {
	scenarios: EvalInventoryScenario[] | null;
	truncated: boolean;
	dropped: number;
} {
	if (artifact.aggregates === undefined) return { scenarios: null, truncated: false, dropped: 0 };
	const projected: EvalInventoryScenario[] = [];
	let dropped = 0;
	for (const entry of artifact.aggregates) {
		if (!isRecord(entry)) {
			dropped += 1;
			continue;
		}
		const scenarioId = identifier(typeof entry.scenarioId === "string" ? entry.scenarioId : null);
		if (scenarioId === null) {
			dropped += 1;
			continue;
		}
		const trials = tally(entry.trials);
		const passed = tally(entry.passed);
		const failed = tally(entry.failed);
		const unmeasured = tally(entry.unmeasured);
		const machineryFailures = tally(entry.machineryFailures);
		// The reducer partitions one scenario's trials into exactly three outcomes
		// and counts machinery failures inside them, so anything else did not come
		// out of `aggregateEvalVerdicts`. It is counted rather than hidden, because
		// a scenario list that looks whole while a reduction was refused would let
		// the wire cross-check read as satisfied.
		if (passed + failed + unmeasured !== trials || machineryFailures > failed) {
			dropped += 1;
			continue;
		}
		projected.push({
			scenarioId,
			trials,
			passed,
			failed,
			unmeasured,
			machineryFailures,
			// Re-derived rather than read, because both are pure functions of the
			// counts beside them and a stored disagreement is not a second opinion.
			passAtK: trials > 0 && passed > 0 ? 1 : 0,
			passPowK: trials > 0 && passed === trials ? 1 : 0,
		});
	}
	const scenarios = projected.slice(0, EVAL_INVENTORY_MAX_SCENARIOS);
	return { scenarios, truncated: scenarios.length < projected.length, dropped };
}

function projectTokens(artifact: EvalArtifactV4): EvalInventoryTokens {
	const tokens = artifact.summary.tokens;
	if (!tokens.measured) {
		return {
			measured: false,
			runs: tally(tokens.runs),
			measuredRuns: 0,
			input: null,
			output: null,
			total: null,
			cacheRead: null,
			cacheWrite: null,
		};
	}
	return {
		measured: true,
		runs: tally(tokens.runs),
		measuredRuns: tally(tokens.measuredRuns),
		input: tally(tokens.input),
		output: tally(tokens.output),
		total: tally(tokens.total),
		cacheRead: tally(tokens.cacheRead),
		cacheWrite: tally(tokens.cacheWrite),
	};
}

function classifyFailure(failureClass: string | null): EvalInventoryFailureClass | null {
	if (failureClass === null) return null;
	return (FAILURE_CLASSES as readonly string[]).includes(failureClass)
		? (failureClass as EvalInventoryFailureClass)
		: "other";
}

function countResults(results: readonly EvalArtifactResultV4[]): {
	counts: EvalInventoryReport["results"];
	failureClasses: EvalInventoryReport["failureClasses"];
	behaviorOutcomes: EvalInventoryReport["behaviorOutcomes"];
} {
	let withAssignment = 0;
	let withTerminalReceipt = 0;
	let withVerdict = 0;
	let withBehavioral = 0;
	let withExecutionEnvelope = 0;
	let machineryFailures = 0;
	let attachments = 0;
	let canonicalMetrics = 0;
	let otherMetrics = 0;
	const failures = new Map<EvalInventoryFailureClass, number>();
	const outcomes = new Map<EvalInventoryBehaviorOutcome, number>();
	for (const result of results) {
		if (result.assignmentId !== null) withAssignment += 1;
		if (result.terminalReceiptDigest !== null) withTerminalReceipt += 1;
		if (result.verdict !== undefined) withVerdict += 1;
		if (result.verdict?.machinery === "infrastructure_failure") machineryFailures += 1;
		if (result.behavioral !== undefined) withBehavioral += 1;
		if (result.executionEnvelope !== undefined) withExecutionEnvelope += 1;
		attachments += Object.keys(result.artifacts).length;
		for (const name of Object.keys(result.metrics)) {
			if (isCanonicalMetric(name)) canonicalMetrics += 1;
			else otherMetrics += 1;
		}
		const failureClass = classifyFailure(result.failureClass);
		if (failureClass !== null) failures.set(failureClass, (failures.get(failureClass) ?? 0) + 1);
		const outcome = result.behavioral?.outcome;
		if (outcome !== undefined && (BEHAVIOR_OUTCOMES as readonly string[]).includes(outcome)) {
			outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
		}
	}
	return {
		counts: {
			total: results.length,
			withAssignment,
			withTerminalReceipt,
			withVerdict,
			withBehavioral,
			withExecutionEnvelope,
			machineryFailures,
			attachments,
			canonicalMetrics,
			otherMetrics,
		},
		failureClasses: REPORTED_FAILURE_CLASSES.flatMap((failureClass) => {
			const count = failures.get(failureClass) ?? 0;
			return count === 0 ? [] : [{ failureClass, count }];
		}),
		behaviorOutcomes: BEHAVIOR_OUTCOMES.flatMap((outcome) => {
			const count = outcomes.get(outcome) ?? 0;
			return count === 0 ? [] : [{ outcome, count }];
		}),
	};
}

function projectReport(
	evalId: string,
	startedAt: string | null,
	artifact: EvalArtifactV4,
	servingGroup: number,
): EvalInventoryReport {
	const serving = evalServingConfigurationOf(artifact);
	const { counts, failureClasses, behaviorOutcomes } = countResults(artifact.results);
	const { scenarios, truncated, dropped } = projectScenarios(artifact);
	const version = artifact.clio.version;
	const commit = artifact.clio.commit;
	return {
		evalId,
		startedAt,
		suiteId: identifier(artifact.suite.id) ?? "unavailable",
		servingGroup,
		clioVersion: VERSION_PATTERN.test(version) ? version : null,
		clioCommit: commit !== null && COMMIT_PATTERN.test(commit) ? commit : null,
		platform: identifier(artifact.environment.platform),
		node: identifier(artifact.environment.node),
		matrix: {
			target: identifier(artifact.matrix.target),
			model: identifier(artifact.matrix.model),
			thinking: identifier(artifact.matrix.thinking),
			dimensions: (artifact.matrix.dimensions ?? []).filter((dimension) =>
				(EVAL_EXECUTION_MATRIX_DIMENSIONS_V1 as readonly string[]).includes(dimension),
			),
		},
		serving: {
			observed: artifact.servingConfiguration !== undefined,
			targetId: identifier(serving.targetId),
			runtimeId: identifier(serving.runtimeId),
			modelId: identifier(serving.modelId),
			serverBuild: identifier(serving.serverBuild),
			thinkingLevel: identifier(serving.thinkingLevel),
			totalSlots: serving.total_slots === null ? null : tally(serving.total_slots),
			compiledPromptPinned: serving.compiledPromptHash !== null,
		},
		summary: {
			runs: tally(artifact.summary.runs),
			passed: tally(artifact.summary.passed),
			failed: tally(artifact.summary.failed),
			passRate: Number.isFinite(artifact.summary.passRate) ? Math.min(1, Math.max(0, artifact.summary.passRate)) : 0,
			wallTimeMs: tally(artifact.summary.wallTimeMs),
			tokens: projectTokens(artifact),
		},
		results: counts,
		failureClasses,
		behaviorOutcomes,
		scenarios,
		scenariosTruncated: truncated,
		scenariosDropped: dropped,
	};
}

export async function evalInventorySnapshot(
	now: () => number = Date.now,
	dataDir: string = clioDataDir(),
): Promise<EvalInventorySnapshot> {
	const listing = await listEvalReports(dataDir, EVAL_INVENTORY_MAX_REPORTS);
	// One group per distinct serving configuration, numbered in the order the
	// window meets them, so the newest report is always in group 1.
	const groups: ReturnType<typeof evalServingConfigurationOf>[] = [];
	const reports = listing.reports.map((stored) => {
		const serving = evalServingConfigurationOf(stored.artifact);
		let index = groups.findIndex((candidate) => sameEvalServingConfiguration(candidate, serving));
		if (index === -1) index = groups.push(serving) - 1;
		return projectReport(stored.evalId, stored.startedAt, stored.artifact, index + 1);
	});
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		available: listing.available,
		stored: listing.stored,
		unreadable: listing.unreadable,
		reports,
		truncated: listing.stored > listing.reports.length + listing.unreadable,
	};
}

/**
 * `clio-coder eval inventory --json`, and nothing else.
 *
 * Anything but the exact argv is a usage error, so a GUI host starts this
 * process knowing it cannot be steered into reading a different store, a wider
 * window, or one named report.
 */
export async function runEvalInventory(args: ReadonlyArray<string>): Promise<number> {
	if (args.length !== 1 || args[0] !== "--json") {
		process.stderr.write("clio-coder eval inventory: usage: clio-coder eval inventory --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(await evalInventorySnapshot(), null, 2)}\n`);
	return 0;
}
