import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { SessionMeta } from "../../src/domains/session/index.js";
import {
	CompactionArtifactProvider,
	DispatchArtifactProvider,
	loadJsonFileLines,
	ReceiptArtifactProvider,
	receiptFilePath,
	runLedgerPath,
	ToolOutputArtifactProvider,
	VIEW_ARTIFACT_LINE_CAP,
	verifyReceiptFile,
} from "../../src/interactive/view/artifacts.js";

async function scratchDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "clio-view-artifacts-"));
}

function fixtureEnvelope(stateDir: string, runId = "run-view-1"): RunEnvelope {
	return {
		id: runId,
		agentId: "coder",
		task: "fix lint errors",
		targetId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: "2026-06-11T12:00:00.000Z",
		endedAt: "2026-06-11T12:00:05.000Z",
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: receiptFilePath(stateDir, runId),
		sessionId: "session-1",
		cwd: "/workspace",
		tokenCount: 42,
		reasoningTokenCount: 0,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0.01,
	};
}

function fixtureReceiptDraft(envelope: RunEnvelope): RunReceiptDraft {
	return {
		runId: envelope.id,
		agentId: envelope.agentId,
		task: envelope.task,
		targetId: envelope.targetId,
		wireModelId: envelope.wireModelId,
		runtimeId: envelope.runtimeId,
		runtimeKind: envelope.runtimeKind,
		startedAt: envelope.startedAt,
		endedAt: envelope.endedAt ?? envelope.startedAt,
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		tokenCount: envelope.tokenCount,
		inputTokenCount: 20,
		outputTokenCount: 22,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: envelope.costUsd,
		compiledPromptHash: null,
		staticCompositionHash: null,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		clioVersion: "0.2.3-test",
		piMonoVersion: "0.79.1",
		platform: "linux",
		nodeVersion: "v22.19.0",
		toolCalls: 0,
		toolStats: [],
		sessionId: envelope.sessionId,
	};
}

async function writeReceiptFixture(stateDir: string): Promise<RunEnvelope> {
	const envelope = fixtureEnvelope(stateDir);
	const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
	await mkdir(join(stateDir, "receipts"), { recursive: true });
	await writeFile(runLedgerPath(stateDir), JSON.stringify([envelope], null, 2));
	await writeFile(receiptFilePath(stateDir, envelope.id), JSON.stringify(receipt, null, 2));
	return envelope;
}

function sessionMeta(): SessionMeta {
	return {
		id: "session-1",
		cwd: "/workspace",
		cwdHash: "cwdhash",
		createdAt: "2026-06-11T12:00:00.000Z",
		endedAt: null,
		model: null,
		target: null,
		clioVersion: "0.2.3-test",
		piMonoVersion: "0.79.1",
		platform: "linux",
		nodeVersion: "v22.19.0",
		sessionFormatVersion: 3,
		workspace: {
			cwd: "/workspace",
			capturedAt: "2026-06-11T12:00:00.000Z",
			isGit: false,
			branch: null,
			dirty: null,
			ahead: null,
			behind: null,
			recentCommits: [],
			remoteUrl: null,
			projectType: "unknown",
		},
	};
}

describe("contracts/view-artifacts", () => {
	it("lists receipt artifacts without loading and verifies plus pretty-prints JSON", async () => {
		const stateDir = await scratchDir();
		const envelope = await writeReceiptFixture(stateDir);
		const provider = new ReceiptArtifactProvider({ stateDir });

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.id, envelope.id);
		strictEqual(artifacts[0]?.category, "receipt");
		ok(artifacts[0]?.path?.endsWith(`${envelope.id}.json`));

		const verify = await artifacts[0]?.verify?.();
		deepStrictEqual(verify, { ok: true, detail: "integrity verified" });
		deepStrictEqual(verifyReceiptFile(stateDir, envelope.id), { ok: true });

		const loaded = await artifacts[0]?.load();
		strictEqual(loaded?.format, "json");
		ok(loaded?.lines.includes(`  "runId": "${envelope.id}",`));
	});

	it("lists receipts written to disk by another process after provider construction", async () => {
		const stateDir = await scratchDir();
		// The in-memory dispatch ledger of this process never learns about the
		// run; only the disk ledger and receipts dir gain the artifact.
		const dispatch = { listRuns: () => [], getRun: () => null };
		const provider = new ReceiptArtifactProvider({ stateDir, dispatch });
		strictEqual((await provider.list()).length, 0);

		const envelope = await writeReceiptFixture(stateDir);
		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.id, envelope.id);
		const verify = await artifacts[0]?.verify?.();
		deepStrictEqual(verify, { ok: true, detail: "integrity verified" });
	});

	it("merges in-memory and disk ledgers without duplicating shared runs", async () => {
		const stateDir = await scratchDir();
		const memoryRun = fixtureEnvelope(stateDir, "run-shared");
		const diskOnlyRun = fixtureEnvelope(stateDir, "run-disk-only");
		const staleDiskCopy = { ...memoryRun, task: "stale disk copy of the shared run" };
		await mkdir(stateDir, { recursive: true });
		await writeFile(runLedgerPath(stateDir), JSON.stringify([staleDiskCopy, diskOnlyRun], null, 2));

		const dispatch = { listRuns: () => [memoryRun], getRun: () => null };
		const provider = new DispatchArtifactProvider({ stateDir, dispatch });
		const artifacts = await provider.list();
		strictEqual(artifacts.length, 2);
		const shared = artifacts.find((artifact) => artifact.id === "run-shared");
		ok(shared, "shared run listed once");
		ok(shared.title.includes(memoryRun.task), "in-memory envelope wins over the stale disk copy");
		ok(
			artifacts.some((artifact) => artifact.id === "run-disk-only"),
			"disk-only run listed",
		);
	});

	it("lists dispatch artifacts and includes matching session dispatch output", async () => {
		const stateDir = await scratchDir();
		const envelope = await writeReceiptFixture(stateDir);
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "tool-result-1",
				parentTurnId: null,
				timestamp: "2026-06-11T12:00:06.000Z",
				role: "tool_result",
				payload: {
					toolName: "dispatch",
					result: {
						kind: "ok",
						output: "dispatch run output body",
						details: { runId: envelope.id },
					},
				},
			},
		];
		const provider = new DispatchArtifactProvider({ stateDir, readSessionEntries: () => entries });

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.category, "dispatch");
		const loaded = await artifacts[0]?.load();
		strictEqual(loaded?.format, "text");
		ok(loaded?.lines.join("\n").includes("dispatch run output body"));
	});

	it("loads file-backed tool outputs and caps large output files", async () => {
		const stateDir = await scratchDir();
		const outputPath = join(stateDir, "tool-output.txt");
		await writeFile(outputPath, "line 1\nline 2\n");
		const largePath = join(stateDir, "large-output.txt");
		const large = Array.from({ length: VIEW_ARTIFACT_LINE_CAP + 2 }, (_, index) => `line ${index + 1}`).join("\n");
		await writeFile(largePath, large);
		const entries: SessionEntry[] = [
			{
				kind: "bashExecution",
				turnId: "bash-1",
				parentTurnId: null,
				timestamp: "2026-06-11T12:01:00.000Z",
				command: "npm test",
				output: "preview",
				exitCode: 0,
				cancelled: false,
				truncated: true,
				fullOutputPath: outputPath,
			},
			{
				kind: "message",
				turnId: "tool-result-2",
				parentTurnId: null,
				timestamp: "2026-06-11T12:02:00.000Z",
				role: "tool_result",
				payload: {
					toolName: "bash",
					result: {
						kind: "ok",
						output: "preview",
						details: { outputPath: largePath },
					},
				},
			},
			{
				kind: "bashExecution",
				turnId: "missing-file",
				parentTurnId: null,
				timestamp: "2026-06-11T12:03:00.000Z",
				command: "missing",
				output: "preview",
				exitCode: 0,
				cancelled: false,
				truncated: true,
				fullOutputPath: join(stateDir, "missing.txt"),
			},
		];
		const provider = new ToolOutputArtifactProvider({ stateDir, readSessionEntries: () => entries });

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 3);
		const first = artifacts.find((artifact) => artifact.path === outputPath);
		strictEqual((await first?.load())?.lines.join("\n"), "line 1\nline 2");

		const capped = await artifacts.find((artifact) => artifact.path === largePath)?.load();
		strictEqual(capped?.format, "text");
		strictEqual(capped?.lines.length, VIEW_ARTIFACT_LINE_CAP + 1);
		ok(capped?.lines.at(-1)?.includes("truncated, open file directly"));
	});

	it("lists compaction summaries as markdown session artifacts", async () => {
		const stateDir = await scratchDir();
		const meta = sessionMeta();
		const entries: SessionEntry[] = [
			{
				kind: "compactionSummary",
				turnId: "compact-1",
				parentTurnId: null,
				timestamp: "2026-06-11T12:04:00.000Z",
				summary: "Important prior context.",
				tokensBefore: 1000,
				tokensAfter: 300,
				messagesSummarized: 7,
				firstKeptTurnId: "turn-9",
				trigger: "force",
			},
		];
		const provider = new CompactionArtifactProvider({
			stateDir,
			sessionMeta: meta,
			readSessionEntries: () => entries,
		});

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.category, "compaction");
		ok(artifacts[0]?.path?.endsWith("current.jsonl"));
		const loaded = await artifacts[0]?.load();
		strictEqual(loaded?.format, "markdown");
		ok(loaded?.lines.join("\n").includes("Important prior context."));
	});

	it("falls back invalid JSON artifacts to text rendering", async () => {
		const stateDir = await scratchDir();
		const invalid = join(stateDir, "bad.json");
		await writeFile(invalid, "{not json");

		const loaded = await loadJsonFileLines(invalid);
		strictEqual(loaded.format, "text");
		deepStrictEqual(loaded.lines, ["{not json"]);
	});
});
