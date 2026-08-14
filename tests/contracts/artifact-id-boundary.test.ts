import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// BUG-010: evidence ids and eval ids are identifiers, not filesystem paths. A
// traversal id used to join past the store root and read a valid-looking
// artifact outside it. The store now rejects unsafe ids before any read, and the
// CLI maps that to a usage error (exit 2). Valid artifacts are seeded at the
// traversal targets so a regression that reads them fails these tests.

function seedEvidence(dir: string, evidenceId: string): void {
	mkdirSync(dir, { recursive: true });
	const overview = {
		version: 1,
		evidenceId,
		source: { kind: "run", runId: "outside-run" },
		generatedAt: "2026-07-01T00:00:00.000Z",
		runIds: ["outside-run"],
		sessionId: null,
		statuses: ["completed"],
		startedAt: "2026-07-01T00:00:00.000Z",
		endedAt: "2026-07-01T00:00:01.000Z",
		tasks: ["outside task"],
		cwds: ["/x"],
		agentIds: ["tester"],
		targetIds: ["local"],
		runtimeIds: ["local"],
		modelIds: ["none"],
		totals: {
			runs: 1,
			receipts: 0,
			toolCalls: 0,
			toolErrors: 0,
			blockedToolCalls: 0,
			sessionEntries: 0,
			auditRows: 0,
			toolEvents: 0,
			linkedToolEvents: 0,
			protectedArtifacts: 0,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 1000,
		},
		tags: [],
		files: ["overview.json", "findings.json"],
	};
	writeFileSync(join(dir, "overview.json"), JSON.stringify(overview));
	writeFileSync(join(dir, "findings.json"), JSON.stringify({ version: 1, evidenceId, findings: [] }));
}

function seedEval(file: string, evalId: string): void {
	const harness = {
		receiptCount: 0,
		toolCalls: 0,
		retries: 0,
		safetyBlocks: 0,
		correctionLatencyMs: 0,
		validationEvidence: 0,
	};
	const artifact = {
		version: 1,
		evalId,
		taskFile: "/x/tasks.yaml",
		taskFileHash: "a".repeat(64),
		repeat: 1,
		startedAt: "2026-07-01T00:00:00.000Z",
		endedAt: "2026-07-01T00:00:01.000Z",
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 1000,
			harness,
			failureClasses: [],
		},
		results: [
			{
				taskId: "outside-task",
				runId: "outside-run",
				repeatIndex: 0,
				cwd: "/x",
				prompt: "outside",
				tags: [],
				pass: true,
				exitCode: 0,
				tokens: 0,
				costUsd: 0,
				wallTimeMs: 1000,
				harness,
				commands: [
					{
						phase: "verifier",
						index: 0,
						command: "true",
						exitCode: 0,
						signal: null,
						timedOut: false,
						wallTimeMs: 1,
						stdout: "",
						stderr: "",
					},
				],
			},
		],
	};
	writeFileSync(file, JSON.stringify(artifact));
}

describe("contracts/artifact-id-boundary", () => {
	const scratch = makeScratchHome("clio-artifact-id-");
	before(() => {
		// `../../outside-*` from `<data>/evidence` and `<data>/evals` resolves to
		// `<CLIO_CODER_HOME>/outside-*`, so seed valid artifacts there.
		seedEvidence(join(scratch.dir, "outside-evidence"), "outside-evidence");
		mkdirSync(join(scratch.dir, "outside-evals"), { recursive: true });
		seedEval(join(scratch.dir, "outside-evals", "outside-eval.json"), "outside-eval");
	});
	after(() => scratch.cleanup());

	const traversalCases: ReadonlyArray<ReadonlyArray<string>> = [
		["evidence", "inspect", "../../outside-evidence"],
		["eval", "report", "../../outside-evals/outside-eval"],
		["eval", "report", "../../outside-evals/outside-eval", "--format", "swe-jsonl"],
	];

	for (const args of traversalCases) {
		it(`clio-coder ${args.join(" ")} rejects the traversal id before reading outside the store`, async () => {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /invalid .*id|must not contain path separators|outside .*root/i);
		});
	}
});
