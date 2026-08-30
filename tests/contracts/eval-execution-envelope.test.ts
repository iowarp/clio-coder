import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEvalArtifactV4 } from "../../src/domains/eval/artifacts/store.js";
import {
	EVAL_EXECUTION_ENVELOPE_SCHEMA_V1,
	parseEvalExecutionEnvelopeV1,
} from "../../src/domains/eval/schema/execution-envelope.js";
import { loadEvalSuiteFile } from "../../src/domains/eval/suites/load.js";

const DIGEST = "a".repeat(64);

describe("contracts/eval execution envelope", () => {
	it("strictly parses prompt fragments, route, policy, project context, and corpus provenance", () => {
		const parsed = parseEvalExecutionEnvelopeV1(envelope());
		strictEqual(parsed.schema, EVAL_EXECUTION_ENVELOPE_SCHEMA_V1);
		deepStrictEqual(parsed.prompt.fragments, [
			{ id: "identity.clio", version: 1, contentHash: DIGEST },
			{ id: "context.project-rules", version: "unversioned", contentHash: DIGEST },
		]);
		strictEqual(parsed.recipe?.id, "coder");
		strictEqual(parsed.policyHashes.rulePack, DIGEST);
		strictEqual(parsed.projectContext.tier, "bounded");
		strictEqual(parsed.corpus.version, "1.0.0");
	});

	it("rejects malformed hashes and duplicate fragments", () => {
		const malformed = envelope();
		malformed.prompt.compositionHash = "short";
		throws(() => parseEvalExecutionEnvelopeV1(malformed), /compositionHash: expected sha256 digest/u);
		const duplicate = envelope();
		duplicate.prompt.fragments.push({ id: "identity.clio", version: 1, contentHash: DIGEST });
		throws(() => parseEvalExecutionEnvelopeV1(duplicate), /duplicate fragment id/u);
	});

	it("keeps Artifact v4 identity and rejects a cross-linked target or corpus", () => {
		const artifact = artifactWithEnvelope();
		strictEqual(parseEvalArtifactV4(artifact, "fixture").version, 4);
		const [result] = artifact.results;
		if (result === undefined) throw new Error("fixture result missing");
		result.executionEnvelope.target = "other";
		throws(() => parseEvalArtifactV4(artifact, "fixture"), /conflicts with result target or behavioral corpus/u);
	});

	it("loads the public suites with explicit matrix dimensions", async () => {
		const machinery = await loadEvalSuiteFile("benchmarks/eval/behavioral-machinery.yaml");
		const model = await loadEvalSuiteFile("benchmarks/eval/behavioral-model.yaml");
		deepStrictEqual(machinery.suite.matrix.dimensions, []);
		deepStrictEqual(model.suite.matrix.dimensions, ["target", "wireModel", "thinkingLevel"]);
	});
});

function envelope() {
	return {
		schema: EVAL_EXECUTION_ENVELOPE_SCHEMA_V1,
		prompt: {
			fragments: [
				{ id: "identity.clio", version: 1 as const, contentHash: DIGEST },
				{ id: "context.project-rules", version: "unversioned" as const, contentHash: DIGEST },
			],
			compositionHash: DIGEST,
		},
		recipe: { id: "coder", version: 1, contentHash: DIGEST },
		target: "mini",
		wireModel: "qwen",
		runtime: "llamacpp",
		thinkingLevel: "off",
		toolSignature: DIGEST,
		autonomy: "auto-edit",
		policyHashes: { rulePack: DIGEST, project: null },
		projectContext: {
			kind: "worker" as const,
			tier: "bounded",
			contentHash: DIGEST,
			chars: 100,
			sections: ["clio-md"],
			rulesApplied: ["project-rule"],
			operatorProfileApplied: false,
		},
		corpus: { id: "public-built-in-behavior", version: "1.0.0" },
	};
}

function artifactWithEnvelope() {
	const executionEnvelope = envelope();
	return {
		version: 4,
		evalId: "eval-envelope",
		suite: { id: "suite", hash: DIGEST },
		clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
		environment: { platform: "linux-x64", node: process.version },
		matrix: { target: "mini", model: "qwen", thinking: "off", dimensions: [] },
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: { measured: false, runs: 1, measuredRuns: 0 },
			wallTimeMs: 1,
		},
		results: [
			{
				assignmentId: null,
				terminalReceiptDigest: null,
				taskId: "scenario",
				repeatIndex: 0,
				target: { id: "mini", model: "qwen", thinking: "off" },
				pass: true,
				failureClass: null,
				metrics: {},
				artifacts: {},
				verdict: verdict(),
				behavioral: behavior(),
				executionEnvelope,
			},
		],
	};
}

function verdict() {
	return {
		schema: "clio.eval.verdict.v1",
		scenarioId: "scenario",
		trialIndex: 0,
		outcome: "pass",
		machinery: "ok",
		reason: null,
		trackedMetrics: {
			modelCalls: sourced(0),
			uncachedPrefillTokens: sourced(0),
			cacheReadTokens: sourced(0),
			generatedTokens: sourced(0),
			reasoningTokens: { value: null, source: "estimated" },
			toolCalls: sourced(0),
			toolErrors: sourced(0),
			ttftMsFirstCall: sourced(0),
			wallClockMs: sourced(0),
			contextTokensAtEnd: sourced(0),
			compactions: sourced(0),
			expectedColdReasons: {},
		},
		behavioral: null,
		evidence: { assignmentId: null, terminalReceiptDigest: null, graderExitCode: 0 },
	};
}

function behavior() {
	const categories = [
		"tool_choice",
		"exploration",
		"delegation",
		"safety_comprehension",
		"claim_grounding",
		"denied_tool_recovery",
		"completion_behavior",
		"task_correctness",
	];
	return {
		schema: "clio.eval.behavior.v1",
		verdictRef: { schema: "clio.eval.verdict.v1", scenarioId: "scenario", trialIndex: 0 },
		corpus: { id: "public-built-in-behavior", version: "1.0.0" },
		judgeInputDigest: DIGEST,
		outcome: "unmeasured",
		labels: categories.map((category) => ({
			category,
			label: "unmeasured",
			ruleIds: [],
			evidence: [],
			explanation: null,
		})),
	};
}

function sourced(value: number) {
	return { value, source: "estimated" };
}
