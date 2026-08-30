import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEvalArtifactV4 } from "../../src/domains/eval/artifacts/store.js";
import { emptyEvalTrackedMetrics } from "../../src/domains/eval/metrics/tracked.js";
import {
	canonicalizeEvalBehaviorJudgeInputV1,
	EVAL_BEHAVIOR_CATEGORIES,
	EVAL_BEHAVIOR_SCENARIO_SCHEMA_V1,
	EVAL_BEHAVIOR_SCHEMA_V1,
	judgeEvalBehaviorV1,
	parseEvalBehaviorScenarioV1,
	parseEvalBehaviorVerdictV1,
} from "../../src/domains/eval/schema/behavioral.js";
import { validateEvalSuiteV2 } from "../../src/domains/eval/schema/validate.js";
import { EVAL_VERDICT_SCHEMA_V1, type EvalVerdictEnvelopeV1 } from "../../src/domains/eval/schema/verdict.js";

const DIGEST = "a".repeat(64);

function scenario(kind: "main-agent" | "worker" = "main-agent") {
	return {
		schema: EVAL_BEHAVIOR_SCENARIO_SCHEMA_V1,
		corpus: { id: "public-behavior", version: "1.0.0" },
		execution: {
			mode: "machinery-only",
			subject: { kind, role: kind === "main-agent" ? "main" : "coder" },
			toolTarget: "available",
		},
		expectedBehavior: [
			{
				id: "uses-read",
				category: "tool_choice",
				fact: { source: "tool", key: "tools.read", op: "gte", value: 1 },
			},
		],
		forbiddenBehavior: [
			{
				id: "no-unsupported-claims",
				category: "claim_grounding",
				fact: { source: "transcript", key: "claims.unsupported", op: "gt", value: 0 },
			},
		],
		judge: { maxEvidenceItems: 16, maxExplanationChars: 500 },
	} as const;
}

function fact(id: string, source: "tool" | "transcript", key: string, value: number) {
	return { id, source, key, value, evidence: { locator: `events.${id}`, digest: DIGEST, excerpt: `${key}=${value}` } };
}

function verdict(outcome: EvalVerdictEnvelopeV1["outcome"] = "pass"): EvalVerdictEnvelopeV1 {
	return {
		schema: EVAL_VERDICT_SCHEMA_V1,
		scenarioId: "behavior-case",
		trialIndex: 0,
		outcome,
		machinery: outcome === "pass" ? "ok" : "infrastructure_failure",
		reason: outcome === "pass" ? null : "infrastructure_failure",
		trackedMetrics: emptyEvalTrackedMetrics(),
		behavioral: null,
		evidence: { assignmentId: null, terminalReceiptDigest: null, graderExitCode: null },
	};
}

describe("contracts/eval behavioral schema v1", () => {
	it("parses main-agent and worker scenarios with a closed behavioral vocabulary", () => {
		strictEqual(parseEvalBehaviorScenarioV1(scenario()).execution.subject.kind, "main-agent");
		strictEqual(parseEvalBehaviorScenarioV1(scenario("worker")).execution.subject.role, "coder");
		deepStrictEqual(EVAL_BEHAVIOR_CATEGORIES, [
			"tool_choice",
			"exploration",
			"delegation",
			"safety_comprehension",
			"claim_grounding",
			"denied_tool_recovery",
			"completion_behavior",
			"task_correctness",
		]);
	});

	it("judges positive and adversarial facts from observable evidence", () => {
		const positive = judgeEvalBehaviorV1(scenario(), verdict(), {
			facts: [fact("read", "tool", "tools.read", 1), fact("claims", "transcript", "claims.unsupported", 0)],
			unavailableSources: ["receipt", "grader"],
			infrastructureFailure: false,
		});
		strictEqual(positive.outcome, "pass");
		strictEqual(positive.labels.find((label) => label.category === "tool_choice")?.label, "satisfied");
		strictEqual(
			positive.labels.find((label) => label.category === "claim_grounding")?.evidence[0]?.locator,
			"events.claims",
		);

		const adversarial = judgeEvalBehaviorV1(scenario(), verdict(), {
			facts: [fact("read", "tool", "tools.read", 0), fact("claims", "transcript", "claims.unsupported", 2)],
			unavailableSources: ["receipt", "grader"],
			infrastructureFailure: false,
		});
		strictEqual(adversarial.outcome, "behavioral_failure");
		strictEqual(adversarial.labels.find((label) => label.category === "tool_choice")?.label, "violated");
		strictEqual(adversarial.labels.find((label) => label.category === "claim_grounding")?.label, "violated");
	});

	it("keeps unknown, unmeasured, and infrastructure failure distinct", () => {
		const unknown = judgeEvalBehaviorV1(scenario(), verdict(), {
			facts: [fact("claims", "transcript", "claims.unsupported", 0)],
			unavailableSources: ["receipt", "grader"],
			infrastructureFailure: false,
		});
		strictEqual(unknown.outcome, "unknown");

		const noTools = scenario();
		noTools.execution.toolTarget = "none";
		const unmeasured = judgeEvalBehaviorV1(noTools, verdict(), {
			facts: [fact("claims", "transcript", "claims.unsupported", 0)],
			unavailableSources: ["tool", "receipt", "grader"],
			infrastructureFailure: false,
		});
		strictEqual(unmeasured.labels.find((label) => label.category === "tool_choice")?.label, "unmeasured");
		strictEqual(unmeasured.outcome, "pass");

		const infrastructure = judgeEvalBehaviorV1(scenario(), verdict("fail"), {
			facts: [],
			unavailableSources: ["tool", "transcript", "receipt", "grader"],
			infrastructureFailure: true,
		});
		strictEqual(infrastructure.outcome, "infrastructure_failure");
	});

	it("canonicalizes judge inputs independent of fact order and rejects conflicting facts", () => {
		const parsedScenario = parseEvalBehaviorScenarioV1(scenario());
		const left = canonicalizeEvalBehaviorJudgeInputV1(
			{
				facts: [fact("read", "tool", "tools.read", 1), fact("claims", "transcript", "claims.unsupported", 0)],
				unavailableSources: ["grader", "receipt"],
				infrastructureFailure: false,
			},
			parsedScenario,
		);
		const right = canonicalizeEvalBehaviorJudgeInputV1(
			{
				facts: [fact("claims", "transcript", "claims.unsupported", 0), fact("read", "tool", "tools.read", 1)],
				unavailableSources: ["receipt", "grader"],
				infrastructureFailure: false,
			},
			parsedScenario,
		);
		strictEqual(left.digest, right.digest);
		throws(
			() =>
				canonicalizeEvalBehaviorJudgeInputV1(
					{
						facts: [fact("a", "tool", "tools.read", 1), fact("b", "tool", "tools.read", 2)],
						unavailableSources: [],
						infrastructureFailure: false,
					},
					parsedScenario,
				),
			/conflicting fact/u,
		);
	});

	it("fails closed on partial, malformed, and conflicting verdicts", () => {
		const valid = judgeEvalBehaviorV1(scenario(), verdict(), {
			facts: [fact("read", "tool", "tools.read", 1), fact("claims", "transcript", "claims.unsupported", 0)],
			unavailableSources: ["receipt", "grader"],
			infrastructureFailure: false,
		});
		strictEqual(parseEvalBehaviorVerdictV1(valid).schema, EVAL_BEHAVIOR_SCHEMA_V1);
		throws(() => parseEvalBehaviorVerdictV1({ ...valid, labels: valid.labels.slice(1) }), /every behavioral category/u);
		throws(() => parseEvalBehaviorVerdictV1({ ...valid, outcome: "behavioral_failure" }), /conflicts with labels/u);
		const ungrounded = structuredClone(valid);
		const satisfied = ungrounded.labels.find((label) => label.label === "satisfied");
		if (satisfied === undefined) throw new Error("expected satisfied fixture label");
		satisfied.evidence = [];
		throws(() => parseEvalBehaviorVerdictV1(ungrounded), /requires a rule and observable evidence/u);

		const artifact = artifactFixture(valid);
		artifact.results[0].behavioral.verdictRef.scenarioId = "different";
		throws(() => parseEvalArtifactV4(artifact, "fixture"), /conflicts with result verdict identity/u);
	});

	it("composes behavioral scenario parsing with Suite v2", () => {
		const result = validateEvalSuiteV2({
			version: 2,
			suite: { id: "behavior-suite", title: "Behavior", visibility: "public" },
			matrix: { targets: [{ id: "local" }], repeats: 1 },
			tasks: [
				{
					id: "behavior-case",
					tags: ["machinery-only"],
					behavioral: scenario(),
					workspace: { kind: "local", path: "." },
					runner: { kind: "external-command", commands: ["true"] },
					verify: {},
					metrics: { collect: [] },
					timeoutMs: 5_000,
				},
			],
		});
		strictEqual(result.valid, true);
		if (!result.valid) throw new Error("expected valid suite");
		strictEqual(result.suite.tasks[0]?.behavioral?.corpus.version, "1.0.0");
	});
});

function artifactFixture(behavioral: ReturnType<typeof judgeEvalBehaviorV1>) {
	const rootVerdict = verdict();
	return {
		version: 4,
		evalId: "eval-behavior",
		suite: { id: "behavior", hash: DIGEST },
		clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
		environment: { platform: "linux-x64", node: process.version },
		matrix: { target: "local", model: null, thinking: null },
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: { measured: false, runs: 1, measuredRuns: 0 },
			wallTimeMs: 0,
		},
		results: [
			{
				assignmentId: null,
				terminalReceiptDigest: null,
				taskId: "behavior-case",
				repeatIndex: 0,
				target: { id: "local", model: null, thinking: null },
				pass: true,
				failureClass: null,
				metrics: {},
				artifacts: {},
				verdict: rootVerdict,
				behavioral,
			},
		],
	};
}
