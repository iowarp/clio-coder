import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import test from "node:test";
import { parseEvalArtifactV4 } from "../../src/domains/eval/artifacts/store.js";
import { compareEvalArtifactsV4, EvalServingConfigurationDriftError } from "../../src/domains/eval/compare/compare.js";
import { aggregateEvalVerdicts } from "../../src/domains/eval/metrics/aggregate.js";
import { renderEvalComparisonReportV1 } from "../../src/domains/eval/reports/comparison.js";
import { toolBehaviorMetricEntriesFromJsonl } from "../../src/domains/eval/runners/clio-run.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { buildEvalBehaviorMetricsV1 } from "../../src/domains/eval/schema/behavioral-metrics.js";
import {
	EVAL_EXECUTION_ENVELOPE_SCHEMA_V1,
	type EvalExecutionEnvelopeV1,
	type EvalExecutionMatrixDimensionV1,
} from "../../src/domains/eval/schema/execution-envelope.js";
import type { EvalSuiteV2 } from "../../src/domains/eval/schema/suite.js";
import { validateEvalSuiteV2 } from "../../src/domains/eval/schema/validate.js";
import {
	EVAL_VERDICT_SCHEMA_V1,
	type EvalTrackedMetricsV1,
	type EvalVerdictEnvelopeV1,
	parseEvalVerdictEnvelopeV1,
	safeParseEvalVerdictEnvelopeV1,
} from "../../src/domains/eval/schema/verdict.js";
import { resolveSuiteForRun } from "../../src/domains/eval/suites/resolve.js";

const DIGEST = "a".repeat(64);
const ROUTE_DIMENSIONS: EvalExecutionMatrixDimensionV1[] = ["target", "wireModel", "runtime", "thinkingLevel"];
const BASELINE_ROUTE = { id: "baseline-target", model: "baseline-model", thinking: "off" };
const CANDIDATE_ROUTE = { id: "candidate-target", model: "candidate-model", thinking: "high" };

test("behavioral tool facts distinguish successful dispatch from attempts", () => {
	const stdout = [
		{ type: "tool_execution_end", toolCallId: "failed", toolName: "dispatch", outcome: "error" },
		{ type: "tool_execution_end", toolCallId: "passed", toolName: "dispatch", outcome: "ok" },
	]
		.map((event) => JSON.stringify(event))
		.join("\n");
	const metrics = toolBehaviorMetricEntriesFromJsonl(stdout, process.cwd());
	strictEqual(metrics["tools.calls.dispatch"], 2);
	strictEqual(metrics["tools.succeeded.dispatch"], 1);
});

test("eval suites fail closed at the versioned schema boundary", () => {
	const accepted = validateEvalSuiteV2(validSuite());
	strictEqual(accepted.valid, true);

	const malformed = validateEvalSuiteV2([validSuite()]);
	strictEqual(malformed.valid, false);

	const partial = validSuite();
	delete (partial as { tasks?: unknown }).tasks;
	const partialResult = validateEvalSuiteV2(partial);
	strictEqual(partialResult.valid, false);
	if (partialResult.valid) throw new Error("partial suite unexpectedly passed");
	strictEqual(
		partialResult.issues.some((issue) => issue.path === "$.tasks"),
		true,
	);

	const contradictory = validSuite();
	const contradictoryTask = contradictory.tasks[0];
	if (contradictoryTask === undefined) throw new Error("valid suite is missing its task fixture");
	(contradictoryTask.runner as { agent?: string }).agent = "coder";
	const contradictoryResult = validateEvalSuiteV2(contradictory);
	strictEqual(contradictoryResult.valid, false);
	if (contradictoryResult.valid) throw new Error("contradictory suite unexpectedly passed");
	strictEqual(
		contradictoryResult.issues.some((issue) => issue.path === "$.tasks[0].runner.agent"),
		true,
	);
});

test("target/model overrides preserve a single-row suite's thinking dimension", () => {
	const suite = validSuite() as unknown as EvalSuiteV2;
	suite.matrix.targets = [{ id: "mini", model: "baseline-model", thinking: "off" }];
	const resolved = resolveSuiteForRun(suite, { target: "lmstudio", model: "candidate-model" });
	deepStrictEqual(resolved.matrix.targets, [{ id: "lmstudio", model: "candidate-model", thinking: "off" }]);
});

test("a target override does not invent thinking when a matrix has multiple source rows", () => {
	const suite = validSuite() as unknown as EvalSuiteV2;
	suite.matrix.targets = [
		{ id: "first", thinking: "off" },
		{ id: "second", thinking: "high" },
	];
	const resolved = resolveSuiteForRun(suite, { target: "lmstudio", model: "candidate-model" });
	deepStrictEqual(resolved.matrix.targets, [{ id: "lmstudio", model: "candidate-model" }]);
});

test("eval readers normalize released schema, runner, and provenance identifiers in memory", () => {
	const legacySuite = validSuite();
	const task = legacySuite.tasks[0];
	if (task === undefined) throw new Error("valid suite is missing its task fixture");
	(task as { runner: unknown }).runner = { kind: "clio-run", prompt: "legacy runner" };
	const validated = validateEvalSuiteV2(legacySuite);
	strictEqual(validated.valid, true);
	if (!validated.valid) throw new Error("legacy runner was not accepted");
	strictEqual(validated.suite.tasks[0]?.runner.kind, "clio-coder-run");

	const legacyVerdict = { ...verdict(), schema: "clio.eval.verdict.v1" };
	strictEqual(parseEvalVerdictEnvelopeV1(legacyVerdict).schema, EVAL_VERDICT_SCHEMA_V1);

	const canonicalArtifact = artifact("eval-legacy", "server-a");
	const legacyArtifact = { ...canonicalArtifact, clio: canonicalArtifact.clioCoder } as Record<string, unknown>;
	Reflect.deleteProperty(legacyArtifact, "clioCoder");
	const parsed = parseEvalArtifactV4(legacyArtifact, "legacy artifact");
	deepStrictEqual(parsed.clioCoder, canonicalArtifact.clioCoder);
	strictEqual("clio" in (parsed as unknown as Record<string, unknown>), false);
});

test("verdict envelopes preserve identity and cannot turn malformed facts into passes", () => {
	const valid = verdict();
	deepStrictEqual(parseEvalVerdictEnvelopeV1(valid), valid);

	const malformedMetrics = structuredClone(valid);
	malformedMetrics.trackedMetrics.modelCalls.value = -1;
	const malformedDigest = structuredClone(valid);
	malformedDigest.evidence.terminalReceiptDigest = "not-a-digest";
	const partial = {
		schema: EVAL_VERDICT_SCHEMA_V1,
		scenarioId: valid.scenarioId,
		trialIndex: valid.trialIndex,
		outcome: "pass",
		machinery: "ok",
	};
	const invalid: unknown[] = [
		null,
		partial,
		{ ...valid, machinery: "infrastructure_failure" },
		{ ...valid, reason: "grader_failed" },
		malformedMetrics,
		malformedDigest,
	];

	for (const candidate of invalid) {
		const parsed = safeParseEvalVerdictEnvelopeV1(candidate);
		strictEqual(parsed.ok, false, `invalid verdict parsed: ${JSON.stringify(candidate)}`);
	}

	const failed = verdict("fail");
	failed.reason = "grader_failed";
	failed.evidence.graderExitCode = 7;
	const parsedFailure = parseEvalVerdictEnvelopeV1(failed);
	strictEqual(parsedFailure.outcome, "fail");
	strictEqual(parsedFailure.reason, "grader_failed");
	deepStrictEqual(parsedFailure.evidence, {
		assignmentId: null,
		terminalReceiptDigest: null,
		graderExitCode: 7,
	});
});

test("eval comparison refuses serving drift until the operator explicitly allows it", () => {
	const baseline = artifact("eval-baseline", "server-a");
	const candidate = artifact("eval-candidate", "server-b");

	throws(
		() => compareEvalArtifactsV4(baseline, candidate),
		(error: unknown) => {
			strictEqual(error instanceof EvalServingConfigurationDriftError, true);
			match((error as Error).message, /pass --allow-config-drift/u);
			return true;
		},
	);

	const allowed = compareEvalArtifactsV4(baseline, candidate, { allowConfigDrift: true });
	strictEqual(allowed.configDrift, true);
	strictEqual(allowed.baselineServingConfiguration.serverBuild, "server-a");
	strictEqual(allowed.candidateServingConfiguration.serverBuild, "server-b");
});

test("eval artifact readers and comparison preserve null first-call timing", () => {
	const baseline = artifact("eval-baseline", "server-a");
	const candidate = artifact("eval-candidate", "server-a");
	const previous = verdict();
	previous.trackedMetrics.ttftMsFirstCall = { value: 0, source: "estimated" };
	const absent = structuredClone(previous);
	absent.trackedMetrics.ttftMsFirstCall.value = null;
	baseline.aggregates = aggregateEvalVerdicts([previous]);
	candidate.aggregates = aggregateEvalVerdicts([parseEvalVerdictEnvelopeV1(absent)]);
	const parsed = parseEvalArtifactV4(JSON.parse(JSON.stringify(candidate)), "candidate");
	const comparison = compareEvalArtifactsV4(baseline, parsed, { metric: "ttftMsFirstCall" }).trackedMetrics[0];
	strictEqual(comparison?.candidate.measured, 0);
	strictEqual(comparison?.candidate.mean, null);
	strictEqual(comparison?.meanDelta, null);
	strictEqual(comparison?.change, "incomparable");
});

test("behavioral comparisons align jointly declared route dimensions before checking envelopes", () => {
	const baseline = behaviorArtifact("eval-baseline", BASELINE_ROUTE, ROUTE_DIMENSIONS);
	const candidate = behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, [...ROUTE_DIMENSIONS].reverse());
	const originals = structuredClone({ baseline, candidate });
	const comparison = compareEvalArtifactsV4(baseline, candidate, { allowConfigDrift: true });
	deepStrictEqual(comparison.envelopeMismatches, []);
	strictEqual(comparison.hardGate.pass, true);
	strictEqual(comparison.behavioralMetrics.length, 10);
	const toolCalls = comparison.behavioralMetrics.find((row) => row.metric === "efficiency.toolCalls");
	strictEqual(toolCalls?.baseline.observations, 2);
	strictEqual(toolCalls?.candidate.observations, 2);
	strictEqual(toolCalls?.baseline.mean, 2);
	strictEqual(toolCalls?.candidate.mean, 2);
	strictEqual(toolCalls?.baseline.variance, 1);
	strictEqual(toolCalls?.change, "unchanged");
	deepStrictEqual(toolCalls?.baselineTargets, [{ id: BASELINE_ROUTE.id, model: BASELINE_ROUTE.model }]);
	deepStrictEqual(toolCalls?.candidateTargets, [{ id: CANDIDATE_ROUTE.id, model: CANDIDATE_ROUTE.model }]);
	deepStrictEqual(toolCalls?.target, toolCalls?.baselineTargets[0]);
	deepStrictEqual({ baseline, candidate }, originals);
});

test("behavioral route alignment requires both declarations and keeps undeclared route keys separate", () => {
	for (const dimensions of [[], ["target"], ["wireModel"]] satisfies EvalExecutionMatrixDimensionV1[][]) {
		const baseline = behaviorArtifact("eval-baseline", BASELINE_ROUTE, dimensions);
		const candidate = behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, dimensions);
		const comparison = compareEvalArtifactsV4(baseline, candidate);
		strictEqual(comparison.hardGate.pass, false);
		deepStrictEqual(
			comparison.envelopeMismatches.map((row) => row.fields),
			[["executionEnvelope"], ["executionEnvelope"]],
		);
		strictEqual(comparison.behavioralMetrics.length, 20);
		for (const row of comparison.behavioralMetrics) {
			strictEqual(row.baselineTargets.length + row.candidateTargets.length, 1);
			strictEqual(row.comparability.comparable, false);
		}
	}
	for (const missingSide of ["baseline", "candidate"] as const) {
		const pair = {
			baseline: behaviorArtifact("eval-baseline", BASELINE_ROUTE, ROUTE_DIMENSIONS),
			candidate: behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, ROUTE_DIMENSIONS),
		};
		delete pair[missingSide].matrix.dimensions;
		const comparison = compareEvalArtifactsV4(pair.baseline, pair.candidate);
		strictEqual(comparison.hardGate.pass, false);
		deepStrictEqual(
			comparison.envelopeMismatches.map((row) => row.fields),
			[["matrix.dimensions"], ["matrix.dimensions"]],
		);
	}
});

test("behavioral grouping varies target and model independently without combining scenarios or roles", () => {
	for (const dimension of ["target", "wireModel"] as const) {
		const baseline = behaviorArtifact("eval-baseline", BASELINE_ROUTE, [dimension, "runtime"]);
		const route = { ...BASELINE_ROUTE, [dimension === "target" ? "id" : "model"]: "changed" };
		const candidate = behaviorArtifact("eval-candidate", route, [dimension, "runtime"]);
		for (const fixture of [baseline, candidate]) {
			const result = fixture.results[0];
			ok(result?.behavioralMetrics);
			const differentScenario = structuredClone(result);
			ok(differentScenario.behavioralMetrics);
			differentScenario.taskId = "second-case";
			differentScenario.behavioralMetrics.scenarioId = "second-case";
			const differentRole = structuredClone(result);
			ok(differentRole.behavioralMetrics);
			differentRole.behavioralMetrics.role = "worker";
			fixture.results.push(differentScenario, differentRole);
		}
		candidate.results.reverse();
		const comparison = compareEvalArtifactsV4(baseline, candidate);
		strictEqual(comparison.hardGate.pass, true);
		strictEqual(comparison.behavioralMetrics.length, 30);
		deepStrictEqual(comparison.envelopeMismatches, []);
	}
});

test("behavioral comparisons reject missing scenarios, roles, envelopes, and partially missing trials", () => {
	for (const missing of ["scenario", "role", "envelope", "trial"] as const) {
		const baseline = behaviorArtifact("eval-baseline", BASELINE_ROUTE, ROUTE_DIMENSIONS);
		const candidate = behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, ROUTE_DIMENSIONS);
		if (missing === "scenario") candidate.results = [];
		else if (missing === "role") {
			for (const result of candidate.results) {
				ok(result.behavioralMetrics);
				result.behavioralMetrics.role = "worker";
			}
		} else {
			for (const result of missing === "trial" ? candidate.results.slice(0, 1) : candidate.results) {
				delete result.executionEnvelope;
			}
		}
		const comparison = compareEvalArtifactsV4(baseline, candidate);
		strictEqual(comparison.hardGate.pass, false, missing);
		const field = missing === "trial" ? "executionEnvelope.missingTrial" : "executionEnvelope";
		deepStrictEqual(
			comparison.envelopeMismatches.map((row) => row.fields),
			missing === "role" ? [[field], [field]] : [[field]],
		);
		ok(comparison.behavioralMetrics.every((row) => row.comparability.comparable === false));
	}
});

test("behavioral route alignment rejects ambiguous multi-route groups on either side", () => {
	for (const side of ["baseline", "candidate"] as const) {
		for (const field of ["id", "model"] as const) {
			const pair = {
				baseline: behaviorArtifact("eval-baseline", BASELINE_ROUTE, ROUTE_DIMENSIONS),
				candidate: behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, ROUTE_DIMENSIONS),
			};
			const extra = behaviorArtifact("eval-extra", { ...BASELINE_ROUTE, [field]: "extra-route" }, ROUTE_DIMENSIONS);
			pair[side].results.push(...extra.results);
			const comparison = compareEvalArtifactsV4(pair.baseline, pair.candidate);
			strictEqual(comparison.hardGate.pass, false);
			deepStrictEqual(
				comparison.envelopeMismatches.map((row) => row.fields),
				[["behavioralMetrics.ambiguousRouteGroup"]],
			);
			strictEqual(comparison.envelopeMismatches[0]?.[`${side}Targets`]?.length, 2);
			ok(comparison.behavioralMetrics.every((row) => row.change === "incomparable"));
			ok(renderEvalComparisonReportV1(comparison, "text").includes("extra-route"));
		}
	}
});

test("declared route alignment preserves non-varying prompt, skill, policy, context, and corpus mismatches", () => {
	const changes: Array<[string, (envelope: EvalExecutionEnvelopeV1) => void]> = [
		[
			"prompt",
			(envelope) => {
				envelope.prompt.compositionHash = "b".repeat(64);
			},
		],
		[
			"recipe",
			(envelope) => {
				envelope.recipe = { id: "skill-fixture", version: 1, contentHash: DIGEST };
			},
		],
		[
			"toolSignature",
			(envelope) => {
				envelope.toolSignature = "b".repeat(64);
			},
		],
		[
			"autonomy",
			(envelope) => {
				envelope.autonomy = "auto-edit";
			},
		],
		[
			"policyHashes",
			(envelope) => {
				envelope.policyHashes.project = "b".repeat(64);
			},
		],
		[
			"projectContext",
			(envelope) => {
				envelope.projectContext.contentHash = "b".repeat(64);
			},
		],
		[
			"corpus",
			(envelope) => {
				envelope.corpus.version = "2.0.0";
			},
		],
	];
	for (const [field, change] of changes) {
		const baseline = behaviorArtifact("eval-baseline", BASELINE_ROUTE, ROUTE_DIMENSIONS);
		const candidate = behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, ROUTE_DIMENSIONS);
		for (const result of candidate.results) {
			ok(result.executionEnvelope);
			change(result.executionEnvelope);
		}
		const comparison = compareEvalArtifactsV4(baseline, candidate);
		strictEqual(comparison.hardGate.pass, false, field);
		deepStrictEqual(
			comparison.envelopeMismatches.map((row) => row.fields),
			[[field]],
		);
		ok(comparison.behavioralMetrics.every((row) => row.comparability.comparable === false));
		deepStrictEqual(
			comparison.affectedCorpusResults,
			field === "prompt" || field === "recipe" ? [{ scenarioId: "route-case", role: "main", changedFields: [field] }] : [],
		);
	}
	for (const dimension of ["runtime", "thinkingLevel"] as const) {
		const dimensions = ROUTE_DIMENSIONS.filter((entry) => entry !== dimension);
		const comparison = compareEvalArtifactsV4(
			behaviorArtifact("eval-baseline", BASELINE_ROUTE, dimensions),
			behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, dimensions),
		);
		strictEqual(comparison.hardGate.pass, false);
		deepStrictEqual(
			comparison.envelopeMismatches.map((row) => row.fields),
			[[dimension]],
		);
	}
});

test("behavioral comparison retains within-run envelope variance checks and legacy envelope compatibility", () => {
	const baseline = behaviorArtifact("eval-baseline", BASELINE_ROUTE, ROUTE_DIMENSIONS);
	const candidate = behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, ROUTE_DIMENSIONS);
	const result = candidate.results[0];
	ok(result?.executionEnvelope);
	result.executionEnvelope.projectContext.chars = 101;
	const comparison = compareEvalArtifactsV4(baseline, candidate);
	strictEqual(comparison.hardGate.pass, false);
	deepStrictEqual(
		comparison.envelopeMismatches.map((row) => row.fields),
		[["executionEnvelope.withinRunVariance"]],
	);
	const legacy = behaviorArtifact("eval-legacy", BASELINE_ROUTE);
	for (const entry of legacy.results) delete entry.executionEnvelope;
	strictEqual(compareEvalArtifactsV4(legacy, structuredClone(legacy)).hardGate.pass, true);
});

test("behavioral comparison reports retain both routes and hard failures despite metric filtering", () => {
	const baseline = behaviorArtifact("eval-baseline", BASELINE_ROUTE, ROUTE_DIMENSIONS);
	const candidate = behaviorArtifact("eval-candidate", CANDIDATE_ROUTE, ROUTE_DIMENSIONS);
	for (const result of candidate.results) {
		ok(result.behavioralMetrics);
		result.behavioralMetrics.metrics["correctness.taskSolved"].value = 0;
	}
	for (const metric of ["correctness", "efficiency"]) {
		const comparison = compareEvalArtifactsV4(baseline, candidate, { metric });
		strictEqual(comparison.hardGate.pass, false);
		strictEqual(comparison.hardGate.failures.length, 1);
		strictEqual(comparison.hardGate.failures[0]?.change, "regressed");
		for (const format of ["text", "json", "md", "junit"] as const) {
			const report = renderEvalComparisonReportV1(comparison, format);
			for (const route of [BASELINE_ROUTE, CANDIDATE_ROUTE]) {
				ok(report.includes(route.id), format);
				ok(report.includes(route.model), format);
			}
			ok(report.includes("regressed"), format);
		}
	}
});

function validSuite() {
	return {
		version: 2,
		suite: { id: "boundary", title: "Boundary", visibility: "public" },
		matrix: { targets: [{ id: "local" }], repeats: 1 },
		tasks: [
			{
				id: "offline-check",
				tags: ["contract"],
				workspace: { kind: "local", path: "." },
				runner: { kind: "external-command", commands: ["true"] },
				verify: { assertions: [{ metric: "result.pass", op: "eq", value: true }] },
				metrics: { collect: ["result.pass"] },
				timeoutMs: 5_000,
			},
		],
	};
}

function verdict(outcome: EvalVerdictEnvelopeV1["outcome"] = "pass"): EvalVerdictEnvelopeV1 {
	return {
		schema: EVAL_VERDICT_SCHEMA_V1,
		scenarioId: "boundary-case",
		trialIndex: 0,
		outcome,
		machinery: "ok",
		reason: null,
		trackedMetrics: trackedMetrics(),
		behavioral: null,
		evidence: { assignmentId: null, terminalReceiptDigest: null, graderExitCode: 0 },
	};
}

function trackedMetrics(): EvalTrackedMetricsV1 {
	const measured = { value: 0, source: "ledger" as const };
	return {
		modelCalls: { ...measured },
		uncachedPrefillTokens: { ...measured },
		cacheReadTokens: { ...measured },
		generatedTokens: { ...measured },
		reasoningTokens: { ...measured },
		toolCalls: { ...measured },
		toolErrors: { ...measured },
		ttftMsFirstCall: { ...measured },
		wallClockMs: { ...measured },
		contextTokensAtEnd: { ...measured },
		compactions: { ...measured },
		expectedColdReasons: {},
	};
}

function artifact(evalId: string, serverBuild: string): EvalArtifactV4 {
	return {
		version: 4,
		evalId,
		suite: { id: "boundary", hash: DIGEST },
		clioCoder: { version: "test", commit: null, entry: "dist/cli/index.js" },
		environment: { platform: "linux-x64", node: process.version },
		matrix: { target: "mini", model: "qwen", thinking: "off" },
		servingConfiguration: {
			targetId: "mini",
			runtimeId: "llamacpp",
			modelId: "qwen",
			serverBuild,
			total_slots: 1,
			thinkingLevel: "off",
			compiledPromptHash: DIGEST,
		},
		summary: {
			runs: 0,
			passed: 0,
			failed: 0,
			passRate: 0,
			tokens: { measured: false, runs: 0, measuredRuns: 0 },
			wallTimeMs: 0,
		},
		results: [],
	};
}

function behaviorArtifact(
	evalId: string,
	target: EvalArtifactResultV4["target"],
	dimensions: EvalExecutionMatrixDimensionV1[] = [],
): EvalArtifactV4 {
	const fixture = artifact(evalId, "fixture-server");
	fixture.matrix = { target: target.id, model: target.model, thinking: target.thinking, dimensions: [...dimensions] };
	fixture.results = [1, 3].map((toolCalls, repeatIndex) => {
		const result: EvalArtifactResultV4 = {
			taskId: "route-case",
			repeatIndex,
			target: { ...target },
			pass: true,
			failureClass: null,
			assignmentId: null,
			terminalReceiptDigest: null,
			metrics: { "task.solved": true, "tools.totalCalls": toolCalls },
			artifacts: {},
			executionEnvelope: {
				schema: EVAL_EXECUTION_ENVELOPE_SCHEMA_V1,
				prompt: { fragments: [{ id: "fixture", version: 1, contentHash: DIGEST }], compositionHash: DIGEST },
				recipe: null,
				target: target.id,
				wireModel: target.model,
				runtime: `runtime-${target.id}`,
				thinkingLevel: target.thinking,
				toolSignature: DIGEST,
				autonomy: "read-only",
				policyHashes: { rulePack: DIGEST, project: DIGEST },
				projectContext: {
					kind: "session",
					tier: "full",
					contentHash: DIGEST,
					chars: 100,
					sections: ["overview"],
					rulesApplied: [],
					operatorProfileApplied: false,
				},
				corpus: { id: "route-fixture", version: "1.0.0" },
			},
		};
		result.behavioralMetrics = buildEvalBehaviorMetricsV1(result, "main");
		return result;
	});
	return fixture;
}
