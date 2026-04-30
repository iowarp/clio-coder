import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { EvalRunArtifact } from "../../src/domains/eval/index.js";
import { buildEvalEvidence, evalEvidenceId, inspectEvidence } from "../../src/domains/evidence/index.js";

describe("eval evidence integration", () => {
	let scratch: string;
	let dataDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-eval-evidence-"));
		dataDir = join(scratch, "data");
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("builds deterministic evidence artifacts from eval results", async () => {
		const artifact = evalArtifact();
		const evidenceId = evalEvidenceId(artifact.evalId);
		const linkedArtifact: EvalRunArtifact = {
			...artifact,
			results: artifact.results.map((result) => ({ ...result, evidenceId })),
		};

		const first = await buildEvalEvidence({ dataDir, artifact: linkedArtifact });
		const second = await buildEvalEvidence({ dataDir, artifact: linkedArtifact });

		strictEqual(first.evidenceId, "eval-eval-fixed");
		deepStrictEqual(second.overview, first.overview);
		strictEqual(first.overview.source.kind, "eval");
		if (first.overview.source.kind !== "eval") throw new Error("expected eval evidence source");
		strictEqual(first.overview.source.evalId, "eval-fixed");
		strictEqual(first.overview.totals.runs, 2);
		strictEqual(first.overview.totals.toolCalls, 2);
		strictEqual(first.overview.totals.toolErrors, 1);
		strictEqual(first.overview.totals.tokens, 0);
		strictEqual(first.overview.totals.costUsd, 0);
		deepStrictEqual(first.overview.tags, ["test-failure"]);
		ok(first.overview.files.includes("eval-result.json"));

		const inspected = await inspectEvidence(dataDir, first.evidenceId);
		strictEqual(inspected.findings.length, 1);
		strictEqual(inspected.findings[0]?.tag, "test-failure");

		const toolEvents = readFileSync(join(first.directory, "tool-events.jsonl"), "utf8");
		ok(toolEvents.includes('"source":"eval-command"'));
		ok(toolEvents.includes('"tool":"eval.verifier"'));
		ok(toolEvents.includes('"errors":1'));

		const evalResult = readFileSync(join(first.directory, "eval-result.json"), "utf8");
		ok(evalResult.includes('"evidenceId": "eval-eval-fixed"'));
	});
});

function evalArtifact(): EvalRunArtifact {
	return {
		version: 1,
		evalId: "eval-fixed",
		taskFile: "/repo/tasks.yaml",
		taskFileHash: "a".repeat(64),
		repeat: 1,
		startedAt: "2026-04-29T00:00:00.000Z",
		endedAt: "2026-04-29T00:00:02.000Z",
		summary: {
			runs: 2,
			passed: 1,
			failed: 1,
			passRate: 0.5,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 200,
			failureClasses: [{ failureClass: "verifier_failed", count: 1 }],
		},
		results: [
			{
				taskId: "passes",
				runId: "eval-fixed-passes-001",
				repeatIndex: 0,
				cwd: "/repo",
				prompt: "Run passing verifier.",
				tags: ["unit"],
				pass: true,
				exitCode: 0,
				tokens: 0,
				costUsd: 0,
				wallTimeMs: 100,
				commands: [
					{
						phase: "verifier",
						index: 0,
						command: "true",
						exitCode: 0,
						signal: null,
						timedOut: false,
						wallTimeMs: 100,
						stdout: "",
						stderr: "",
					},
				],
			},
			{
				taskId: "fails",
				runId: "eval-fixed-fails-001",
				repeatIndex: 0,
				cwd: "/repo",
				prompt: "Run failing verifier.",
				tags: ["unit"],
				pass: false,
				exitCode: 1,
				tokens: 0,
				costUsd: 0,
				wallTimeMs: 100,
				failureClass: "verifier_failed",
				commands: [
					{
						phase: "verifier",
						index: 0,
						command: "false",
						exitCode: 1,
						signal: null,
						timedOut: false,
						wallTimeMs: 100,
						stdout: "",
						stderr: "failed",
					},
				],
			},
		],
	};
}
