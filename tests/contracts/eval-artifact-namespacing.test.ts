/**
 * `skills-eval` (version-1 EvalRunArtifact, store.ts) and `clio-coder eval run`
 * (version-4 EvalArtifactV4, artifacts/store.ts) both resolved an evalId to
 * `<dataDir>/evals/<evalId>.json` before this fix, so a shared id let one
 * writer's schema silently clobber the other's file. This pins that a run of
 * each writer, given the identical id, leaves both artifacts intact and
 * independently readable through their own loader.
 */
import { notStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadEvalArtifactV4, writeEvalArtifactV4 } from "../../src/domains/eval/artifacts/store.js";
import { ZERO_EVAL_HARNESS_METRICS } from "../../src/domains/eval/harness-metrics.js";
import { loadEvalArtifact, writeEvalArtifact } from "../../src/domains/eval/store.js";
import type { EvalRunArtifact } from "../../src/domains/eval/types.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";

const SHARED_EVAL_ID = "shared-namespacing-test-id";

function v1Fixture(): EvalRunArtifact {
	return {
		version: 1,
		evalId: SHARED_EVAL_ID,
		taskFile: "skills-eval/fixture-task-file.md",
		taskFileHash: "a".repeat(64),
		clioCoder: { version: "0.0.0-test", commit: null, entry: "test" },
		environment: { platform: "test-platform", node: "test-node" },
		target: null,
		model: null,
		thinking: null,
		paths: { taskFile: "skills-eval/fixture-task-file.md", receipts: [], sessionLedgers: [] },
		repeat: 1,
		startedAt: "2026-09-02T00:00:00.000Z",
		endedAt: "2026-09-02T00:00:01.000Z",
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 1000,
			harness: { ...ZERO_EVAL_HARNESS_METRICS },
			failureClasses: [],
		},
		results: [],
	};
}

function v4Fixture(): EvalArtifactV4 {
	return {
		version: 4,
		evalId: SHARED_EVAL_ID,
		suite: { id: "fixture-suite-v4", hash: "b".repeat(64) },
		clioCoder: { version: "0.0.0-test", commit: null, entry: "test" },
		environment: { platform: "test-platform", node: "test-node" },
		matrix: { target: "test-target", model: null, thinking: null },
		summary: { runs: 1, passed: 1, failed: 0, passRate: 1, tokens: { measured: false, runs: 1, measuredRuns: 0 }, wallTimeMs: 1000 },
		results: [],
	};
}

describe("eval artifact writers do not share an output path for the same id", () => {
	let dataDir: string;

	before(() => {
		dataDir = mkdtempSync(join(tmpdir(), "clio-eval-namespacing-"));
	});
	after(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("writes both the legacy and v4 artifact for the same evalId to distinct paths, and both round-trip", async () => {
		const v1Path = await writeEvalArtifact(dataDir, v1Fixture());
		const v4Path = await writeEvalArtifactV4(dataDir, v4Fixture());

		notStrictEqual(v1Path, v4Path);

		const loadedV1 = await loadEvalArtifact(dataDir, SHARED_EVAL_ID);
		strictEqual(loadedV1.version, 1);
		strictEqual(loadedV1.taskFileHash, "a".repeat(64));

		const loadedV4 = await loadEvalArtifactV4(dataDir, SHARED_EVAL_ID);
		strictEqual(loadedV4.version, 4);
		strictEqual(loadedV4.suite.hash, "b".repeat(64));
	});

	it("survives the opposite write order without either artifact clobbering the other", async () => {
		const otherId = "shared-namespacing-test-id-reverse";
		await writeEvalArtifactV4(dataDir, { ...v4Fixture(), evalId: otherId });
		await writeEvalArtifact(dataDir, { ...v1Fixture(), evalId: otherId });

		const loadedV4 = await loadEvalArtifactV4(dataDir, otherId);
		strictEqual(loadedV4.version, 4);
		const loadedV1 = await loadEvalArtifact(dataDir, otherId);
		strictEqual(loadedV1.version, 1);
	});
});
