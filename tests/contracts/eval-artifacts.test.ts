import { ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	loadEvalArtifactV4,
	parseEvalArtifactV4,
	writeEvalArtifactV4,
} from "../../src/domains/eval/artifacts/store.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { createEvalId, evalArtifactPath, loadEvalArtifact } from "../../src/domains/eval/store.js";
import type { EvalRunArtifact } from "../../src/domains/eval/types.js";

function artifact(): EvalArtifactV4 {
	return {
		version: 4,
		evalId: "eval-explicit-link",
		suite: { id: "contract", hash: "suite-hash" },
		clio: { version: "test", commit: null, entry: "/tmp/clio" },
		environment: { platform: "linux", node: "v24" },
		matrix: { target: "local", model: null, thinking: null },
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: { measured: true, runs: 1, measuredRuns: 1, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
			wallTimeMs: 1,
		},
		results: [
			{
				assignmentId: "assignment-1",
				terminalReceiptDigest: "a".repeat(64),
				taskId: "task",
				repeatIndex: 0,
				target: { id: "local", model: null, thinking: null },
				pass: true,
				failureClass: null,
				metrics: {},
				artifacts: { stdout: "Authorization: Bearer secretsecretsecret" },
			},
		],
	};
}

function storedArtifact(): EvalRunArtifact {
	return {
		version: 1,
		evalId: "eval-provenance",
		taskFile: "/tmp/tasks.yaml",
		taskFileHash: "abc123",
		clio: { version: "test", commit: null, entry: "/tmp/clio" },
		environment: { platform: "linux", node: "v24" },
		target: null,
		model: null,
		thinking: null,
		paths: { taskFile: "/tmp/tasks.yaml", receipts: [], sessionLedgers: [] },
		repeat: 1,
		startedAt: "2026-07-01T00:00:00.000Z",
		endedAt: "2026-07-01T00:00:01.000Z",
		summary: {
			runs: 0,
			passed: 0,
			failed: 0,
			passRate: 0,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 1000,
			harness: {
				receiptCount: 0,
				toolCalls: 0,
				retries: 0,
				safetyBlocks: 0,
				correctionLatencyMs: 0,
				validationEvidence: 0,
			},
			failureClasses: [],
		},
		results: [],
	};
}

describe("contracts/eval artifacts", () => {
	it("records explicit assignment and terminal receipt linkage", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-artifact-v3-"));
		try {
			await writeEvalArtifactV4(join(root, "data"), artifact());
			const loaded = await loadEvalArtifactV4(join(root, "data"), "eval-explicit-link");
			strictEqual(loaded.results[0]?.assignmentId, "assignment-1");
			strictEqual(loaded.results[0]?.terminalReceiptDigest, "a".repeat(64));
			const raw = readFileSync(join(root, "data", "evals", "eval-explicit-link.json"), "utf8");
			ok(!raw.includes("secretsecretsecret"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects the retired artifact shape", () => {
		const retired = { ...artifact(), version: 3 };
		throws(() => parseEvalArtifactV4(retired, "retired"), /current version 4/);
		const missingReference = structuredClone(artifact());
		delete (missingReference.results[0] as { assignmentId?: string }).assignmentId;
		throws(() => parseEvalArtifactV4(missingReference, "missing-reference"), /assignmentId/);
	});

	for (const field of ["clio", "environment", "paths"] as const) {
		it(`rejects a stored eval artifact missing ${field} provenance`, async () => {
			const root = mkdtempSync(join(tmpdir(), "clio-eval-provenance-"));
			try {
				const dataDir = join(root, "data");
				const artifactPath = join(dataDir, "evals", "eval-provenance.json");
				mkdirSync(join(dataDir, "evals"), { recursive: true });
				const incomplete = storedArtifact() as EvalRunArtifact & Record<string, unknown>;
				delete incomplete[field];
				writeFileSync(artifactPath, JSON.stringify(incomplete));

				await rejects(loadEvalArtifact(dataDir, "eval-provenance"), {
					message: `eval artifact has an invalid schema: missing required field '${field}' in ${artifactPath}. Re-run the evaluation suite to generate a complete artifact.`,
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("gives two same-millisecond runs of one task file distinct ids and distinct artifact paths", () => {
		// evalArtifactPath maps an id straight to one file. Before the random
		// suffix, two workers starting the same task file in the same millisecond
		// produced the same path and the second clobbered the first.
		const startedAt = new Date("2026-08-15T00:00:00.000Z");
		const ids = new Set(Array.from({ length: 64 }, () => createEvalId(startedAt, "abc123def456")));
		strictEqual(ids.size, 64);
		for (const id of ids) {
			ok(id.startsWith("eval-20260815T000000000Z-abc123de-"), id);
			ok(/-[0-9a-f]{12}$/.test(id), id);
			// The suffix must not smuggle a path separator past the store's id guard.
			strictEqual(evalArtifactPath("/tmp/data", id), join("/tmp/data", "evals", `${id}.json`));
		}
	});
});
