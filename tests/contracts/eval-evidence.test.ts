import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EvalRunArtifact } from "../../src/domains/eval/types.js";
import { buildEvalEvidence } from "../../src/domains/evidence/eval.js";

function artifact(cwd: string): EvalRunArtifact {
	return {
		version: 1,
		evalId: "eval-linked",
		taskFile: "/tmp/tasks.yaml",
		taskFileHash: "abc123",
		clio: { version: "0.2.8", commit: "fixture-commit", entry: "dist/cli/index.js" },
		environment: { platform: "linux-x64", node: "v24.0.0" },
		target: null,
		model: null,
		thinking: null,
		paths: { taskFile: "/tmp/tasks.yaml", receipts: [], sessionLedgers: [] },
		repeat: 1,
		startedAt: "2026-07-01T10:00:00.000Z",
		endedAt: "2026-07-01T10:05:00.000Z",
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 300000,
			harness: {
				receiptCount: 0,
				toolCalls: 0,
				retries: 0,
				safetyBlocks: 0,
				correctionLatencyMs: 0,
				validationEvidence: 1,
			},
			failureClasses: [],
		},
		results: [
			{
				taskId: "voipi",
				runId: "run-nested",
				repeatIndex: 0,
				cwd,
				prompt: "fix the target",
				tags: [],
				pass: true,
				exitCode: 0,
				tokens: 0,
				costUsd: 0,
				wallTimeMs: 300000,
				harness: {
					receiptCount: 0,
					toolCalls: 0,
					retries: 0,
					safetyBlocks: 0,
					correctionLatencyMs: 0,
					validationEvidence: 1,
				},
				commands: [],
			},
		],
	};
}

describe("contracts/eval evidence linking", () => {
	it("links nested clio run rows only by exact durable run id", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-evidence-"));
		try {
			const dataDir = join(root, "data");
			const stateDir = join(root, "state");
			const cwd = join(root, "target");
			const receiptPath = join(stateDir, "receipts", "run-nested.json");
			mkdirSync(join(stateDir, "receipts"), { recursive: true });
			mkdirSync(join(stateDir, "audit"), { recursive: true });
			mkdirSync(join(stateDir, "sessions", "hash", "session-nested"), { recursive: true });
			mkdirSync(cwd, { recursive: true });

			const run = {
				id: "run-nested",
				agentId: "coder",
				task: "fix the target",
				targetId: "mini",
				wireModelId: "Qwopus-test",
				runtimeId: "llamacpp",
				runtimeKind: "http",
				startedAt: "2026-07-01T10:01:00.000Z",
				endedAt: "2026-07-01T10:02:00.000Z",
				status: "completed",
				outcome: "succeeded",
				outcomeDetail: null,
				exitCode: 0,
				pid: null,
				heartbeatAt: null,
				receiptPath,
				sessionId: "session-nested",
				cwd,
				tokenCount: 42,
				costUsd: 0.001,
			};
			writeFileSync(join(stateDir, "runs.json"), `${JSON.stringify([run], null, 2)}\n`);
			writeFileSync(
				receiptPath,
				`${JSON.stringify(
					{
						...run,
						runId: run.id,
						compiledPromptHash: null,
						staticCompositionHash: null,
						clioVersion: "test",
						piMonoVersion: "test",
						platform: process.platform,
						nodeVersion: process.version,
						toolCalls: 1,
						toolStats: [{ tool: "verify", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 12 }],
						sessionId: "session-nested",
						integrity: { version: 3, algorithm: "sha256", digest: "fixture" },
					},
					null,
					2,
				)}\n`,
			);
			writeFileSync(
				join(stateDir, "sessions", "hash", "session-nested", "current.jsonl"),
				`${[
					JSON.stringify({ type: "session", version: 3, id: "session-nested", timestamp: run.startedAt, cwd }),
					JSON.stringify({
						kind: "message",
						role: "assistant",
						turnId: "turn-1",
						parentTurnId: null,
						timestamp: run.endedAt,
						payload: { text: "validated" },
					}),
				].join("\n")}\n`,
			);
			writeFileSync(
				join(stateDir, "audit", "2026-07-01.jsonl"),
				`${JSON.stringify({
					kind: "completion_contract",
					ts: "2026-07-01T10:02:00.000Z",
					correlationId: "audit-1",
					runId: "run-nested",
					turnId: "turn-1",
					decision: "ok",
					reason: "validation_evidence",
					rigor: "high",
					mutatedPaths: ["src/app.ts"],
					evidenceKinds: ["validation_command"],
				})}\n`,
			);

			const result = await buildEvalEvidence({ dataDir, stateDir, artifact: artifact(cwd) });

			strictEqual(result.overview.runIds[0], "run-nested");
			strictEqual(result.overview.modelIds[0], "Qwopus-test");
			strictEqual(result.overview.totals.receipts, 1);
			strictEqual(result.overview.totals.auditRows, 1);
			strictEqual(result.overview.totals.sessionEntries, 1);
			strictEqual(result.overview.totals.linkedToolEvents, 1);
			const receiptFile = JSON.parse(readFileSync(join(result.directory, "receipt.json"), "utf8")) as {
				receipts: unknown[];
			};
			strictEqual(receiptFile.receipts.length, 1);
			ok(!result.overview.modelIds.includes("none"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers additive sidecars in overview.files while keeping the base file set", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-sidecar-"));
		try {
			const dataDir = join(root, "data");
			const cwd = join(root, "target");
			mkdirSync(cwd, { recursive: true });

			const withSidecar = await buildEvalEvidence({ dataDir, artifact: artifact(cwd), sidecars: ["skill-eval.json"] });
			ok(withSidecar.overview.files.includes("overview.json"), "base files must survive");
			ok(withSidecar.overview.files.includes("skill-eval.json"), "sidecar must be registered");

			const withoutSidecar = await buildEvalEvidence({ dataDir, artifact: artifact(cwd) });
			ok(!withoutSidecar.overview.files.includes("skill-eval.json"), "no sidecar without the option");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
