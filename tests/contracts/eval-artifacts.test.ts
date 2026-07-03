import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type EvalRunArtifact,
	linkEvalArtifactRuntimePaths,
	loadEvalArtifact,
	writeEvalArtifact,
} from "../../src/domains/eval/index.js";

const ZERO_HARNESS = {
	receiptCount: 0,
	toolCalls: 0,
	retries: 0,
	safetyBlocks: 0,
	correctionLatencyMs: 0,
	validationEvidence: 0,
};

function artifact(root: string): EvalRunArtifact {
	return {
		version: 1,
		evalId: "eval-redaction",
		taskFile: join(root, "tasks.yaml"),
		taskFileHash: "hash-redaction",
		clio: { version: "0.2.8", commit: "fixture-commit", entry: join(root, "dist", "cli", "index.js") },
		environment: { platform: "linux-x64", node: "v24.0.0" },
		target: null,
		model: null,
		thinking: null,
		paths: { taskFile: join(root, "tasks.yaml"), receipts: [], sessionLedgers: [] },
		repeat: 1,
		startedAt: "2026-07-03T10:00:00.000Z",
		endedAt: "2026-07-03T10:00:10.000Z",
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 10,
			harness: { ...ZERO_HARNESS },
			failureClasses: [],
		},
		results: [
			{
				taskId: "task-a",
				runId: "eval-redaction-task-a-001",
				repeatIndex: 0,
				cwd: join(root, "workspace"),
				prompt: "prompt",
				tags: ["redaction"],
				pass: true,
				exitCode: 0,
				tokens: 0,
				costUsd: 0,
				wallTimeMs: 10,
				harness: { ...ZERO_HARNESS },
				commands: [
					{
						phase: "verifier",
						index: 0,
						command: `echo api_key=secretsecretsecret ${join(root, "workspace")}`,
						exitCode: 0,
						signal: null,
						timedOut: false,
						wallTimeMs: 10,
						stdout: `${join(root, "workspace")}\nAuthorization: Bearer secretsecretsecret\n`,
						stderr: "",
					},
				],
			},
		],
	};
}

describe("contracts/eval artifact provenance and redaction", () => {
	it("redacts home prefixes and credential patterns before storing v1 artifacts", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-artifact-"));
		const previousHome = process.env.HOME;
		try {
			process.env.HOME = root;
			const dataDir = join(root, "data");
			const artifactPath = await writeEvalArtifact(dataDir, artifact(root));
			const raw = readFileSync(artifactPath, "utf8");
			ok(!raw.includes(root), "stored artifact must not contain the raw home path");
			ok(raw.includes("$HOME"), "stored artifact should retain a portable home marker");
			ok(!raw.includes("secretsecretsecret"), "stored artifact must not contain credential material");

			const loaded = await loadEvalArtifact(dataDir, "eval-redaction");
			strictEqual(loaded.taskFile, "$HOME/tasks.yaml");
			strictEqual(loaded.clio.entry, "$HOME/dist/cli/index.js");
			strictEqual(loaded.results[0]?.commands[0]?.stdout.includes("$HOME/workspace"), true);
			strictEqual(loaded.results[0]?.commands[0]?.stdout.includes("secretsecretsecret"), false);
		} finally {
			if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("loads legacy v1 artifacts without provenance fields", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-legacy-"));
		try {
			const evalDir = join(root, "data", "evals");
			mkdirSync(evalDir, { recursive: true });
			writeFileSync(
				join(evalDir, "eval-legacy.json"),
				`${JSON.stringify(
					{
						version: 1,
						evalId: "eval-legacy",
						taskFile: "/tmp/tasks.yaml",
						taskFileHash: "legacy-hash",
						repeat: 1,
						startedAt: "2026-07-03T10:00:00.000Z",
						endedAt: "2026-07-03T10:00:01.000Z",
						summary: {
							runs: 0,
							passed: 0,
							failed: 0,
							passRate: 0,
							tokens: 0,
							costUsd: 0,
							wallTimeMs: 0,
							harness: ZERO_HARNESS,
							failureClasses: [],
						},
						results: [],
					},
					null,
					2,
				)}\n`,
			);

			const loaded = await loadEvalArtifact(join(root, "data"), "eval-legacy");
			strictEqual(loaded.clio.version, "unknown");
			strictEqual(loaded.clio.commit, null);
			strictEqual(loaded.environment.node, "unknown");
			strictEqual(loaded.target, null);
			strictEqual(loaded.paths.taskFile, "/tmp/tasks.yaml");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("links matching receipt and session ledger paths when they are present", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-links-"));
		try {
			const stateDir = join(root, "state");
			const cwd = join(root, "workspace");
			const receiptPath = join(stateDir, "receipts", "nested-run.json");
			const sessionLedger = join(stateDir, "sessions", "cwd-hash", "session-1", "current.jsonl");
			mkdirSync(join(stateDir, "receipts"), { recursive: true });
			mkdirSync(join(stateDir, "sessions", "cwd-hash", "session-1"), { recursive: true });
			writeFileSync(receiptPath, "{}\n");
			writeFileSync(sessionLedger, "{}\n");
			writeFileSync(
				join(stateDir, "runs.json"),
				`${JSON.stringify(
					[
						{
							id: "nested-run",
							cwd,
							startedAt: "2026-07-03T10:00:01.000Z",
							endedAt: "2026-07-03T10:00:02.000Z",
							receiptPath,
							sessionId: "session-1",
						},
					],
					null,
					2,
				)}\n`,
			);

			const linked = await linkEvalArtifactRuntimePaths(artifact(root), stateDir, join(root, "data", "evidence", "eval"));
			strictEqual(linked.paths.receipts[0], receiptPath);
			strictEqual(linked.paths.sessionLedgers[0], sessionLedger);
			strictEqual(linked.results[0]?.receiptPath, receiptPath);
			strictEqual(linked.results[0]?.paths?.receipt, receiptPath);
			strictEqual(linked.results[0]?.paths?.sessionLedger, sessionLedger);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
