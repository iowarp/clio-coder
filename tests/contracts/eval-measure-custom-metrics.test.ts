import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isRedactedArtifactKey, redactArtifactForStorage } from "../../src/domains/eval/artifacts/redact.js";
import { loadEvalArtifactV4, writeEvalArtifactV4 } from "../../src/domains/eval/artifacts/store.js";
import { compareEvalArtifactsV4, renderEvalComparisonV4 } from "../../src/domains/eval/compare/compare.js";
import { evaluateGate } from "../../src/domains/eval/compare/gates.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import type { EvalMetricAssertion } from "../../src/domains/eval/schema/suite.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

interface GraderTask {
	id: string;
	metrics: Record<string, unknown>;
	exitCode?: number;
	assertions?: EvalMetricAssertion[];
}

const DIGEST = "0123456789abcdef".repeat(4);
const OTHER_DIGEST = "fedcba9876543210".repeat(4);

async function runGraderSuite(dir: string, tasks: GraderTask[], repeats = 1): Promise<EvalArtifactV4> {
	return runEvalSuiteV2(
		{
			path: join(dir, "suite.yaml"),
			baseDir: dir,
			hash: "a".repeat(64),
			suite: {
				version: 2,
				suite: { id: "measure-custom", title: "Measure custom metrics", visibility: "local" },
				matrix: { targets: [{ id: "fixture" }], repeats },
				tasks: tasks.map((task) => {
					const workspace = join(dir, `workspace-${task.id}`);
					mkdirSync(workspace);
					const line = JSON.stringify({ schema: "clio-coder.eval.measure.v1", metrics: task.metrics });
					writeFileSync(
						join(workspace, "grader.cjs"),
						`console.log(${JSON.stringify(line)});\nprocess.exit(${task.exitCode ?? 0});\n`,
					);
					return {
						id: task.id,
						tags: [],
						workspace: { kind: "temp-copy" as const, path: workspace },
						runner: { kind: "external-command" as const, command: "true" },
						verify: {
							measure: ["node grader.cjs"],
							...(task.assertions === undefined ? {} : { assertions: task.assertions }),
						},
						metrics: { collect: [] },
						timeoutMs: 5000,
					};
				}),
			},
		},
		{ clioEntry: new URL("../../dist/cli/index.js", import.meta.url).pathname },
	);
}

test("measure lines admit custom.* keys per trial and keep them through storage", async () => {
	const env = await isolateClioEnv("eval-measure-custom-");
	try {
		const artifact = await runGraderSuite(
			env.dir,
			[
				{
					id: "custom",
					metrics: {
						"claims.unsupported": 0,
						"custom.io.bytes_read": 1234,
						"custom.cache-hit": true,
						"custom.ratio": 0.5,
						"custom.label": "not a number",
						"custom.has space": 1,
						[`custom.${"x".repeat(122)}`]: 1,
						"custom.": 1,
						"custom.plain_string": DIGEST,
					},
				},
			],
			2,
		);
		assert.equal(artifact.version, 4);
		assert.deepEqual(
			artifact.results.map((result) => result.repeatIndex),
			[0, 1],
		);
		for (const result of artifact.results) {
			assert.equal(result.pass, true);
			assert.equal(result.metrics["custom.io.bytes_read"], 1234);
			assert.equal(result.metrics["custom.cache-hit"], true);
			assert.equal(result.metrics["custom.ratio"], 0.5);
			assert.equal(result.metrics["claims.unsupported"], 0);
			assert.equal(result.metrics["custom.label"], undefined);
			assert.equal(result.metrics["custom.has space"], undefined);
			assert.equal(result.metrics[`custom.${"x".repeat(122)}`], undefined);
			assert.equal(result.metrics["custom."], undefined);
			assert.equal(result.metrics["custom.plain_string"], undefined);
		}
		const dataDir = join(env.dir, "data");
		await writeEvalArtifactV4(dataDir, artifact);
		const stored = await loadEvalArtifactV4(dataDir, artifact.evalId);
		assert.equal(stored.version, 4);
		for (const result of stored.results) {
			assert.equal(result.metrics["custom.io.bytes_read"], 1234);
			assert.equal(result.metrics["custom.cache-hit"], true);
			assert.equal(result.metrics["custom.ratio"], 0.5);
		}
	} finally {
		env.restore();
	}
});

test("measure lines cannot overwrite reserved metrics or add unprefixed keys", async () => {
	const env = await isolateClioEnv("eval-measure-reserved-");
	try {
		const artifact = await runGraderSuite(env.dir, [
			{
				id: "reserved",
				exitCode: 1,
				metrics: { "task.solved": true, "tools.blocked": 7, io_bytes: 5, "custom.kept": 1 },
			},
		]);
		const result = artifact.results[0];
		assert.ok(result);
		assert.equal(result.metrics["task.solved"], false);
		assert.equal(result.metrics["task.exitCode"], 1);
		assert.equal(result.metrics["tools.blocked"], 0);
		assert.equal(result.metrics.io_bytes, undefined);
		assert.equal(result.metrics["custom.kept"], 1);
		assert.equal(result.pass, false);
		assert.equal(result.failureClass, "grader_failed");
	} finally {
		env.restore();
	}
});

test("verify assertions resolve custom.* keys by exact name", async () => {
	const env = await isolateClioEnv("eval-measure-assert-");
	try {
		const metrics = { "custom.io.bytes_read": 1234, "custom.digest.behavior": DIGEST };
		const artifact = await runGraderSuite(env.dir, [
			{ id: "holds", metrics, assertions: [{ metric: "custom.io.bytes_read", op: "gte", value: 1000 }] },
			{ id: "fails", metrics, assertions: [{ metric: "custom.io.bytes_read", op: "lt", value: 1000 }] },
			{ id: "absent", metrics, assertions: [{ metric: "custom.io.bytes_written", op: "gte", value: 0 }] },
			{ id: "digest-eq", metrics, assertions: [{ metric: "custom.digest.behavior", op: "eq", value: DIGEST }] },
			{ id: "digest-neq", metrics, assertions: [{ metric: "custom.digest.behavior", op: "eq", value: OTHER_DIGEST }] },
		]);
		const byTask = new Map(artifact.results.map((result) => [result.taskId, result]));
		assert.equal(byTask.get("holds")?.pass, true);
		assert.equal(byTask.get("fails")?.pass, false);
		assert.equal(byTask.get("fails")?.failureClass, "assertion_failed");
		assert.equal(byTask.get("absent")?.pass, false);
		assert.equal(byTask.get("absent")?.failureClass, "assertion_unresolved");
		assert.equal(byTask.get("digest-eq")?.pass, true);
		assert.equal(byTask.get("digest-neq")?.pass, false);
		assert.equal(byTask.get("digest-neq")?.failureClass, "assertion_failed");
	} finally {
		env.restore();
	}
});

test("a custom.* key the artifact redactor would rewrite fails the measure step by name", async () => {
	const env = await isolateClioEnv("eval-measure-redacted-");
	try {
		const artifact = await runGraderSuite(env.dir, [
			{ id: "redacted", metrics: { "custom.io_token_bytes": 10, "custom.kept": 1 } },
			{ id: "redacted-digest", metrics: { "custom.digest.session_token": DIGEST } },
		]);
		const result = artifact.results[0];
		assert.ok(result);
		assert.equal(result.pass, false);
		assert.equal(result.failureClass, "command_error");
		assert.match(String(result.artifacts.error), /custom\.io_token_bytes/);
		assert.equal(result.metrics["custom.io_token_bytes"], undefined);
		assert.equal(result.metrics["custom.kept"], undefined);
		const digest = artifact.results[1];
		assert.ok(digest);
		assert.equal(digest.failureClass, "command_error");
		assert.match(String(digest.artifacts.error), /custom\.digest\.session_token/);
	} finally {
		env.restore();
	}
});

test("custom.digest.* keys carry only a lowercase SHA-256 hex string", async () => {
	const env = await isolateClioEnv("eval-measure-digest-");
	try {
		const artifact = await runGraderSuite(env.dir, [
			{
				id: "digest",
				metrics: {
					"custom.digest.behavior": DIGEST,
					"custom.digest.upper": DIGEST.toUpperCase(),
					"custom.digest.short": DIGEST.slice(1),
					"custom.digest.number": 5,
					"custom.digest.flag": true,
					"custom.digest.": DIGEST,
					"custom.count": 3,
				},
			},
		]);
		const result = artifact.results[0];
		assert.ok(result);
		assert.equal(result.pass, true);
		assert.equal(result.metrics["custom.digest.behavior"], DIGEST);
		assert.equal(result.metrics["custom.count"], 3);
		for (const dropped of [
			"custom.digest.upper",
			"custom.digest.short",
			"custom.digest.number",
			"custom.digest.flag",
			"custom.digest.",
		]) {
			assert.equal(result.metrics[dropped], undefined, dropped);
		}

		// The redactor neither matches the key nor rewrites the hex value.
		assert.equal(isRedactedArtifactKey("custom.digest.behavior"), false);
		assert.equal(redactArtifactForStorage(result).metrics["custom.digest.behavior"], DIGEST);
		const dataDir = join(env.dir, "data");
		await writeEvalArtifactV4(dataDir, artifact);
		const stored = await loadEvalArtifactV4(dataDir, artifact.evalId);
		assert.equal(stored.results[0]?.metrics["custom.digest.behavior"], DIGEST);

		// Aggregates and compare iterate fixed tracked names, so the string is inert there.
		assert.equal(stored.aggregates?.length, 1);
		assert.ok(!JSON.stringify(stored.aggregates).includes("custom."));
		const comparison = compareEvalArtifactsV4(stored, stored);
		assert.ok(comparison.trackedMetrics.every((row) => !row.metric.startsWith("custom.")));
		assert.ok(!renderEvalComparisonV4(comparison).includes(DIGEST));
		assert.throws(
			() => compareEvalArtifactsV4(stored, stored, { metric: "custom.digest.behavior" }),
			/eval metric not found: custom\.digest\.behavior/,
		);

		// A gate resolves the digest per result and compares the string. A fail
		// threshold trips when its condition holds, and a numeric operator never
		// holds on a string, so it neither trips nor throws.
		const drift = evaluateGate(stored, { fail: [{ metric: "custom.digest.behavior", op: "neq", value: DIGEST }] });
		assert.equal(drift.pass, true);
		const tripped = evaluateGate(stored, { fail: [{ metric: "custom.digest.behavior", op: "eq", value: DIGEST }] });
		assert.equal(tripped.pass, false);
		assert.equal(tripped.failures[0]?.actual, DIGEST);
		assert.equal(tripped.failures[0]?.unresolved, false);
		assert.equal(tripped.failures[0]?.taskId, "digest");
		const numeric = evaluateGate(stored, { fail: [{ metric: "custom.digest.behavior", op: "gte", value: 0 }] });
		assert.equal(numeric.pass, true);
	} finally {
		env.restore();
	}
});
