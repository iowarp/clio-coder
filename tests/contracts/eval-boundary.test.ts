import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import test from "node:test";
import {
	compareEvalArtifactsV4,
	EvalServingConfigurationDriftError,
} from "../../src/domains/eval/compare/compare.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { validateEvalSuiteV2 } from "../../src/domains/eval/schema/validate.js";
import {
	EVAL_VERDICT_SCHEMA_V1,
	parseEvalVerdictEnvelopeV1,
	safeParseEvalVerdictEnvelopeV1,
	type EvalTrackedMetricsV1,
	type EvalVerdictEnvelopeV1,
} from "../../src/domains/eval/schema/verdict.js";

const DIGEST = "a".repeat(64);

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
	strictEqual(partialResult.issues.some((issue) => issue.path === "$.tasks"), true);

	const contradictory = validSuite();
	(contradictory.tasks[0]!.runner as { agent?: string }).agent = "coder";
	const contradictoryResult = validateEvalSuiteV2(contradictory);
	strictEqual(contradictoryResult.valid, false);
	if (contradictoryResult.valid) throw new Error("contradictory suite unexpectedly passed");
	strictEqual(contradictoryResult.issues.some((issue) => issue.path === "$.tasks[0].runner.agent"), true);
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
		clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
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
