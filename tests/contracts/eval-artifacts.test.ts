import { ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	loadEvalArtifactV3,
	parseEvalArtifactV3,
	writeEvalArtifactV3,
} from "../../src/domains/eval/artifacts/store.js";
import type { EvalArtifactV3 } from "../../src/domains/eval/schema/artifact.js";
import { loadEvalArtifact } from "../../src/domains/eval/store.js";
import type { EvalRunArtifact } from "../../src/domains/eval/types.js";

function artifact(): EvalArtifactV3 {
	return {
		version: 3,
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
			tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
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
			await writeEvalArtifactV3(join(root, "data"), artifact());
			const loaded = await loadEvalArtifactV3(join(root, "data"), "eval-explicit-link");
			strictEqual(loaded.results[0]?.assignmentId, "assignment-1");
			strictEqual(loaded.results[0]?.terminalReceiptDigest, "a".repeat(64));
			const raw = readFileSync(join(root, "data", "evals", "eval-explicit-link.json"), "utf8");
			ok(!raw.includes("secretsecretsecret"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects the retired artifact shape", () => {
		const retired = { ...artifact(), version: 2 };
		throws(() => parseEvalArtifactV3(retired, "retired"), /current version 3/);
		const missingReference = structuredClone(artifact());
		delete (missingReference.results[0] as { assignmentId?: string }).assignmentId;
		throws(() => parseEvalArtifactV3(missingReference, "missing-reference"), /assignmentId/);
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
});
