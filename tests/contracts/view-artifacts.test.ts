import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { SessionMeta } from "../../src/domains/session/index.js";
import {
	CompactionArtifactProvider,
	createDefaultArtifactProviders,
	DispatchArtifactProvider,
	EvidenceArtifactProvider,
	listViewArtifacts,
	loadJsonFileLines,
	PromptManifestArtifactProvider,
	ProtectedArtifactProvider,
	ReceiptArtifactProvider,
	receiptFilePath,
	runLedgerPath,
	SafetyAuditArtifactProvider,
	TaskLedgerArtifactProvider,
	ToolOutputArtifactProvider,
	VIEW_ARTIFACT_CATEGORIES,
	VIEW_ARTIFACT_LINE_CAP,
	verifyReceiptFile,
	WorkspaceArtifactProvider,
} from "../../src/interactive/view/artifacts.js";
import { withTimeZoneAsync } from "../harness/clock.js";

async function scratchDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "clio-view-artifacts-"));
}

async function withIsolatedLedgerState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
	const originalEnv = { ...process.env };
	const root = await mkdtemp(join(tmpdir(), "clio-view-ledger-"));
	const stateDir = join(root, "state");
	process.env.CLIO_CODER_HOME = root;
	process.env.CLIO_CODER_CONFIG_DIR = join(root, "config");
	process.env.CLIO_CODER_DATA_DIR = join(root, "data");
	process.env.CLIO_CODER_STATE_DIR = stateDir;
	process.env.CLIO_CODER_CACHE_DIR = join(root, "cache");
	resetXdgCache();
	try {
		return await fn(stateDir);
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
		resetXdgCache();
		await rm(root, { recursive: true, force: true });
	}
}

function fixtureEnvelope(stateDir: string, runId = "run-view-1"): RunEnvelope {
	return {
		id: runId,
		agentId: "coder",
		executionRole: "builder",
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
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		runId: envelope.id,
		agentId: envelope.agentId,
		executionRole: "builder",
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

async function writeEvidenceFixture(dataDir: string): Promise<string> {
	const evidenceId = "run-run-view-1-20260611T120000Z";
	const evidenceDir = join(dataDir, "evidence", evidenceId);
	await mkdir(evidenceDir, { recursive: true });
	const overview = {
		version: 1,
		evidenceId,
		source: { kind: "run", runId: "run-view-1" },
		generatedAt: "2026-06-11T12:10:00.000Z",
		runIds: ["run-view-1"],
		sessionId: "session-1",
		statuses: ["completed"],
		startedAt: "2026-06-11T12:00:00.000Z",
		endedAt: "2026-06-11T12:00:05.000Z",
		tasks: ["fix lint errors"],
		cwds: ["/workspace"],
		agentIds: ["coder"],
		targetIds: ["local"],
		runtimeIds: ["openai"],
		modelIds: ["model-a"],
		totals: {
			runs: 1,
			receipts: 1,
			toolCalls: 2,
			toolErrors: 1,
			blockedToolCalls: 1,
			sessionEntries: 3,
			auditRows: 1,
			toolEvents: 2,
			linkedToolEvents: 1,
			protectedArtifacts: 1,
			tokens: 1530,
			costUsd: 0.0123,
			wallTimeMs: 6500,
		},
		tags: ["audit-linked", "blocked-tool"],
		files: ["overview.json", "findings.json", "receipt.json"],
	};
	await writeFile(join(evidenceDir, "overview.json"), JSON.stringify(overview, null, 2));
	await writeFile(
		join(evidenceDir, "findings.json"),
		JSON.stringify(
			{
				version: 1,
				evidenceId,
				findings: [
					{
						id: "finding-1",
						severity: "warn",
						tag: "blocked-tool",
						runId: "run-view-1",
						message: "1 blocked tool call(s)",
					},
				],
			},
			null,
			2,
		),
	);
	return evidenceId;
}

describe("contracts/view-artifacts", () => {
	it("includes durable proof categories and tolerates missing provider backing stores", async () => {
		deepStrictEqual(VIEW_ARTIFACT_CATEGORIES, [
			"accountability",
			"evidence",
			"receipt",
			"dispatch",
			"task-ledger",
			"workspace",
			"tool-output",
			"protected-artifact",
			"compaction",
			"prompt-manifest",
			"audit",
		]);

		const stateDir = await scratchDir();
		const dataDir = join(stateDir, "missing-data");
		const artifacts = await listViewArtifacts(
			createDefaultArtifactProviders({
				stateDir,
				dataDir,
				readSessionEntries: () => [],
			}),
		);
		ok(artifacts.some((artifact) => artifact.category === "accountability"));
		ok(!artifacts.some((artifact) => artifact.category === "evidence"), "missing data dir produces no evidence rows");
		ok(!artifacts.some((artifact) => artifact.category === "audit"), "missing audit dir produces no audit rows");
		ok(
			createDefaultArtifactProviders({ stateDir }).some((provider) => provider.category === "workspace"),
			"the default /view registry includes workspace outputs",
		);

		const isolated = await listViewArtifacts([
			{
				category: "audit",
				list: async () => {
					throw new Error("boom");
				},
			},
			new EvidenceArtifactProvider({ stateDir }),
		]);
		deepStrictEqual(isolated, []);
	});

	it("snapshots branch-local workspace outputs with deterministic metadata, loading, and missing-file fallbacks", async () => {
		const stateDir = await scratchDir();
		const workspace = await scratchDir();
		const reportPath = join(workspace, "REPORT.md");
		const planPath = join(workspace, "plan.md");
		const notesPath = join(workspace, "notes.txt");
		const largePath = join(workspace, "large.txt");
		await writeFile(reportPath, "# Report\n\nDone.\n");
		await writeFile(planPath, "# Revised plan\n");
		await writeFile(notesPath, "plain text\n");
		await writeFile(
			largePath,
			Array.from({ length: VIEW_ARTIFACT_LINE_CAP + 2 }, (_, index) => `line ${index + 1}`).join("\n"),
		);

		const message = (
			turnId: string,
			parentTurnId: string | null,
			role: "user" | "assistant",
			text: string,
		): SessionEntry => ({
			kind: "message",
			turnId,
			parentTurnId,
			timestamp: "2026-08-19T10:00:00.000Z",
			role,
			payload: { text },
		});
		const toolResult = (input: {
			turnId: string;
			parentTurnId: string;
			toolName: "artifact" | "write" | "edit";
			paths: unknown;
			timestamp: string;
			kind?: string;
			isError?: boolean;
			outcome?: string;
		}): SessionEntry => ({
			kind: "message",
			turnId: input.turnId,
			parentTurnId: input.parentTurnId,
			timestamp: input.timestamp,
			role: "tool_result",
			payload: {
				toolName: input.toolName,
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { paths: input.paths, ...(input.kind ? { kind: input.kind } : {}) },
				},
				...(input.isError === undefined ? {} : { isError: input.isError }),
				...(input.outcome === undefined ? {} : { outcome: input.outcome }),
			},
		});

		const entries: SessionEntry[] = [
			message("user-root", null, "user", "produce files"),
			message("assistant-abandoned", "user-root", "assistant", "abandoned branch"),
			toolResult({
				turnId: "abandoned-write",
				parentTurnId: "assistant-abandoned",
				toolName: "write",
				paths: ["abandoned.txt"],
				timestamp: "2026-08-19T10:01:00.000Z",
			}),
			message("assistant-active", "user-root", "assistant", "active branch"),
			toolResult({
				turnId: "report",
				parentTurnId: "assistant-active",
				toolName: "artifact",
				paths: ["REPORT.md"],
				kind: "report",
				timestamp: "2026-08-19T10:02:00.000Z",
			}),
			toolResult({
				turnId: "plan-first",
				parentTurnId: "report",
				toolName: "artifact",
				paths: ["plan.md"],
				kind: "plan",
				timestamp: "2026-08-19T10:03:00.000Z",
			}),
			toolResult({
				turnId: "plan-edit",
				parentTurnId: "plan-first",
				toolName: "edit",
				paths: [planPath],
				timestamp: "2026-08-19T10:04:00.000Z",
			}),
			toolResult({
				turnId: "notes",
				parentTurnId: "plan-edit",
				toolName: "write",
				paths: ["notes.txt"],
				timestamp: "2026-08-19T10:05:00.000Z",
			}),
			toolResult({
				turnId: "large",
				parentTurnId: "notes",
				toolName: "write",
				paths: ["large.txt"],
				timestamp: "2026-08-19T10:06:00.000Z",
			}),
			toolResult({
				turnId: "gone",
				parentTurnId: "large",
				toolName: "write",
				paths: ["gone.md"],
				timestamp: "2026-08-19T10:07:00.000Z",
			}),
			toolResult({
				turnId: "failed",
				parentTurnId: "gone",
				toolName: "write",
				paths: ["failed.txt"],
				isError: true,
				timestamp: "2026-08-19T10:08:00.000Z",
			}),
			toolResult({
				turnId: "blocked",
				parentTurnId: "failed",
				toolName: "edit",
				paths: ["blocked.txt"],
				outcome: "blocked",
				timestamp: "2026-08-19T10:09:00.000Z",
			}),
			toolResult({
				turnId: "escape",
				parentTurnId: "blocked",
				toolName: "write",
				paths: ["../outside.txt"],
				timestamp: "2026-08-19T10:10:00.000Z",
			}),
			message("assistant-terminal", "escape", "assistant", "done"),
		];
		let reads = 0;
		const provider = new WorkspaceArtifactProvider({
			stateDir,
			sessionMeta: { ...sessionMeta(), cwd: workspace, pinnedLeafTurnId: "assistant-terminal" },
			readSessionEntries: () => {
				reads += 1;
				return entries;
			},
		});
		entries.push(
			toolResult({
				turnId: "late",
				parentTurnId: "assistant-terminal",
				toolName: "write",
				paths: ["late.txt"],
				timestamp: "2026-08-19T10:11:00.000Z",
			}),
		);

		try {
			const artifacts = await provider.list();
			strictEqual(reads, 1, "workspace entries are captured exactly once when /view constructs its providers");
			deepStrictEqual(
				artifacts.map((artifact) => artifact.path),
				[join(workspace, "gone.md"), largePath, notesPath, planPath, reportPath],
			);
			ok(!artifacts.some((artifact) => artifact.path?.includes("abandoned")), "the abandoned branch is excluded");
			ok(!artifacts.some((artifact) => artifact.path?.includes("failed")), "error results are excluded");
			ok(!artifacts.some((artifact) => artifact.path?.includes("blocked")), "blocked results are excluded");
			ok(!artifacts.some((artifact) => artifact.path?.includes("outside")), "workspace escapes are excluded");
			ok(!artifacts.some((artifact) => artifact.path?.includes("late")), "the opening snapshot never polls later entries");

			const report = artifacts.find((artifact) => artifact.path === reportPath);
			ok(report?.title.includes("report"), report?.title);
			ok(report?.searchText?.includes("REPORT.md"));
			ok(report?.searchText?.includes("artifact"));
			ok(report?.searchText?.includes("report"));
			strictEqual((await report?.load())?.format, "markdown");
			ok((await report?.load())?.lines.includes("# Report"));

			const plan = artifacts.find((artifact) => artifact.path === planPath);
			strictEqual(plan?.toolName, "edit");
			ok(plan?.searchText?.includes("1 overwrite"));
			strictEqual((await plan?.load())?.format, "markdown");

			const notes = artifacts.find((artifact) => artifact.path === notesPath);
			strictEqual((await notes?.load())?.format, "text");

			const gone = artifacts.find((artifact) => artifact.path === join(workspace, "gone.md"));
			deepStrictEqual(await gone?.load(), {
				lines: ["file no longer on disk (recorded at 2026-08-19T10:07:00.000Z)"],
				format: "text",
			});

			const large = artifacts.find((artifact) => artifact.path === largePath);
			const largeBody = await large?.load();
			strictEqual(largeBody?.lines.length, VIEW_ARTIFACT_LINE_CAP + 1);
			strictEqual(largeBody?.lines.at(-1), `[truncated, open file directly: ${largePath}]`);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("lists receipt artifacts without loading and verifies plus pretty-prints JSON", async () => {
		const stateDir = await scratchDir();
		const envelope = await writeReceiptFixture(stateDir);
		const provider = new ReceiptArtifactProvider({ stateDir });

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.id, envelope.id);
		strictEqual(artifacts[0]?.category, "receipt");
		strictEqual(artifacts[0]?.runId, envelope.id);
		strictEqual(artifacts[0]?.sessionId, envelope.sessionId);
		ok(artifacts[0]?.path?.endsWith(`${envelope.id}.json`));

		const verify = await artifacts[0]?.verify?.();
		deepStrictEqual(verify, { ok: true, detail: "integrity verified" });
		deepStrictEqual(verifyReceiptFile(stateDir, envelope.id), { ok: true });

		const loaded = await artifacts[0]?.load();
		strictEqual(loaded?.format, "json");
		ok(loaded?.lines.includes(`  "runId": "${envelope.id}",`));
	});

	it("fails verification for a receipt sealed under a retired integrity version", async () => {
		const stateDir = await scratchDir();
		const envelope = await writeReceiptFixture(stateDir);
		const receiptPath = receiptFilePath(stateDir, envelope.id);
		const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
			integrity: { version: number };
		};
		receipt.integrity.version = 3;
		await writeFile(receiptPath, JSON.stringify(receipt, null, 2));

		deepStrictEqual(verifyReceiptFile(stateDir, envelope.id), { ok: false, reason: "integrity invalid" });
		const artifact = (await new ReceiptArtifactProvider({ stateDir }).list())[0];
		deepStrictEqual(await artifact?.verify?.(), { ok: false, detail: "integrity invalid" });
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

	it("reloads disk-written ledger receipts and keeps corrupted artifacts from poisoning /view listings", async () => {
		await withIsolatedLedgerState(async (stateDir) => {
			const staleDispatch = { listRuns: () => [], getRun: () => null };
			const receiptProvider = new ReceiptArtifactProvider({ stateDir, dispatch: staleDispatch });
			const dispatchProvider = new DispatchArtifactProvider({ stateDir, dispatch: staleDispatch });
			deepStrictEqual(await listViewArtifacts([receiptProvider, dispatchProvider]), []);

			const ledger = openLedger({ maxRuns: 10 });
			const created = ledger.create({
				agentId: "coder",
				executionRole: "builder",
				task: "persist across reload",
				targetId: "fixture-openai",
				wireModelId: "fixture-alpha",
				runtimeId: "openai-compat",
				runtimeKind: "http",
				sessionId: "session-persist",
				cwd: "/workspace",
			});
			const completed = ledger.update(created.id, {
				status: "completed",
				outcome: "succeeded",
				outcomeDetail: null,
				endedAt: "2026-06-11T12:00:05.000Z",
				exitCode: 0,
				tokenCount: 42,
				inputTokenCount: 20,
				outputTokenCount: 22,
				cacheReadTokenCount: 0,
				cacheWriteTokenCount: 0,
				reasoningTokenCount: 0,
				costUsd: 0.01,
			});
			ok(completed, "completed ledger row exists");
			ledger.recordReceipt(created.id, fixtureReceiptDraft(completed));
			await ledger.persist();

			const freshLedger = openLedger({ maxRuns: 10 });
			const freshRun = freshLedger.get(created.id);
			ok(freshRun, "fresh ledger instance discovers the persisted run");
			strictEqual(freshRun.receiptPath, receiptFilePath(stateDir, created.id));
			deepStrictEqual(verifyReceiptFile(stateDir, created.id), { ok: true });

			const artifacts = await listViewArtifacts([receiptProvider, dispatchProvider]);
			ok(
				artifacts.some((artifact) => artifact.category === "receipt" && artifact.id === created.id),
				"receipt provider sees disk-written receipt despite stale in-memory dispatch",
			);
			ok(
				artifacts.some((artifact) => artifact.category === "dispatch" && artifact.id === created.id),
				"dispatch provider sees disk-written ledger row despite stale in-memory dispatch",
			);

			const corrupted = fixtureEnvelope(stateDir, "run-corrupt");
			corrupted.receiptPath = receiptFilePath(stateDir, corrupted.id);
			await writeFile(runLedgerPath(stateDir), JSON.stringify([corrupted, ...freshLedger.list()], null, 2));
			await mkdir(join(stateDir, "receipts"), { recursive: true });
			await writeFile(receiptFilePath(stateDir, corrupted.id), "{not json");

			const withCorrupt = await receiptProvider.list();
			ok(
				withCorrupt.some((artifact) => artifact.id === created.id),
				"valid receipt remains listed",
			);
			const corruptedArtifact = withCorrupt.find((artifact) => artifact.id === corrupted.id);
			ok(corruptedArtifact, "corrupted receipt is isolated to its own artifact row");
			const verification = await corruptedArtifact.verify?.();
			strictEqual(verification?.ok, false);
			ok(verification?.detail.startsWith("invalid json:"), verification?.detail);
		});
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
		strictEqual(artifacts[0]?.runId, envelope.id);
		strictEqual(artifacts[0]?.sessionId, envelope.sessionId);
		const loaded = await artifacts[0]?.load();
		strictEqual(loaded?.format, "text");
		ok(loaded?.lines.join("\n").includes("dispatch run output body"));
	});

	it("loads dispatch metadata with shared formatters instead of raw receipt fields", async () => {
		const stateDir = await scratchDir();
		const envelope = fixtureEnvelope(stateDir, "run-format");
		envelope.tokenCount = 1530;
		envelope.costUsd = 0.005;
		envelope.wireModelId = "very-long-single-model-identifier-with-extra-parts";
		await mkdir(stateDir, { recursive: true });
		await writeFile(runLedgerPath(stateDir), JSON.stringify([envelope], null, 2));

		const provider = new DispatchArtifactProvider({ stateDir, readSessionEntries: () => [] });
		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		const loaded = await artifacts[0]?.load();
		const text = loaded?.lines.join("\n") ?? "";

		ok(/\bstarted: \d{2}:\d{2}:\d{2}\b/.test(text), text);
		ok(/\bended: \d{2}:\d{2}:\d{2}\b/.test(text), text);
		ok(!text.includes(envelope.startedAt), "dispatch load should not expose raw startedAt ISO text");
		ok(!text.includes(envelope.endedAt ?? ""), "dispatch load should not expose raw endedAt ISO text");
		ok(text.includes("tokens: 1.5k"), text);
		ok(text.includes("cost: $0.0050"), text);
		ok(!text.includes("costUsd: 0.005"), "dispatch load should not expose the raw costUsd field");
		ok(text.includes("model: very-long-single"), text);
	});

	// The run started at noon UTC. An operator reading the artifact wants the
	// clock on their wall, and the raw instant is one line away in the receipt.
	it("stamps dispatch start and end in the operator's zone, not UTC", async () => {
		const stateDir = await scratchDir();
		const envelope = fixtureEnvelope(stateDir, "run-zone");
		await mkdir(stateDir, { recursive: true });
		await writeFile(runLedgerPath(stateDir), JSON.stringify([envelope], null, 2));

		const body = async (zone: string): Promise<string> =>
			withTimeZoneAsync(zone, async () => {
				const provider = new DispatchArtifactProvider({ stateDir, readSessionEntries: () => [] });
				const artifacts = await provider.list();
				return ((await artifacts[0]?.load())?.lines ?? []).join("\n");
			});

		ok((await body("America/Chicago")).includes("started: 07:00:00"), await body("America/Chicago"));
		ok((await body("Asia/Kolkata")).includes("started: 17:30:00"), await body("Asia/Kolkata"));
		ok((await body("UTC")).includes("started: 12:00:00"), await body("UTC"));
		ok((await body("America/Chicago")).includes("ended: 07:00:05"), await body("America/Chicago"));
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
						details: { outputPath: largePath, runId: "run-view-tool" },
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
		strictEqual(first?.toolName, "bash");
		ok(first?.searchText?.includes("npm test"));
		strictEqual((await first?.load())?.lines.join("\n"), "line 1\nline 2");

		const toolResult = artifacts.find((artifact) => artifact.path === largePath);
		strictEqual(toolResult?.toolName, "bash");
		strictEqual(toolResult?.runId, "run-view-tool");
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
		ok(loaded?.lines.join("\n").includes("- tokens before: 1k"));
		ok(loaded?.lines.join("\n").includes("- tokens after: 300"));
	});

	it("lists prompt compile provenance while isolating malformed manifest lines", async () => {
		const stateDir = await scratchDir();
		const meta = sessionMeta();
		const path = join(stateDir, "sessions", meta.cwdHash, meta.id, "prompt-manifest.jsonl");
		await mkdir(join(stateDir, "sessions", meta.cwdHash, meta.id), { recursive: true });
		const record = {
			at: "2026-06-11T12:04:30.000Z",
			previousHash: null,
			systemPromptHash: "a".repeat(64),
			tokenEstimate: 1530,
			thinkingLevel: "low",
			projectPreload: {
				mode: "full" as const,
				chars: 4000,
				lines: 100,
				reason: null,
				nearLimit: false,
				label: "full (4.0kB, 100 lines)",
			},
			sections: [{ id: "identity", tokenEstimate: 200 }],
			fragments: [
				{
					id: "identity.clio",
					relPath: "identity/clio.md",
					contentHash: "b".repeat(64),
					dynamic: false,
				},
			],
		};
		await writeFile(
			path,
			[JSON.stringify(record), JSON.stringify({ ...record, at: "1" }), JSON.stringify({ at: record.at }), '{"torn'].join(
				"\n",
			),
		);

		const artifacts = await new PromptManifestArtifactProvider({ stateDir, sessionMeta: meta }).list();
		const compile = artifacts.find((artifact) => artifact.id.startsWith("prompt-manifest:1:"));
		ok(compile, "valid compile is listed despite later malformed lines");
		strictEqual(compile.category, "prompt-manifest");
		strictEqual(compile.sessionId, meta.id);
		strictEqual(compile.path, path);
		ok(compile.title.includes("1.5k"), compile.title);
		ok(compile.searchText?.includes("identity/clio.md"));

		const loaded = await compile.load();
		const text = loaded.lines.join("\n");
		strictEqual(loaded.format, "json");
		ok(text.includes(`"systemPromptHash": "${"a".repeat(64)}"`), text);
		ok(text.includes('"thinkingLevel": "low"'), text);

		const errors = artifacts.find((artifact) => artifact.id === "prompt-manifest:read-errors");
		ok(errors, "invalid records are visible as provenance gaps");
		const errorText = (await errors.load()).lines.join("\n");
		ok(errorText.includes("line 2: invalid prompt manifest record"), errorText);
		ok(errorText.includes("line 3: invalid prompt manifest record"), errorText);
		ok(errorText.includes("line 4: invalid JSON"), errorText);
	});

	it("lists and loads task ledger snapshots as markdown artifacts", async () => {
		const stateDir = await scratchDir();
		const meta = sessionMeta();
		const entries: SessionEntry[] = [
			{
				kind: "taskLedger",
				turnId: "ledger-1",
				parentTurnId: null,
				timestamp: "2026-06-11T12:05:00.000Z",
				boardId: "board-release-1",
				goals: [{ id: "G1", title: "Ship proof catalog", status: "active" }],
				subgoals: [
					{
						id: "T1",
						title: "Add evidence provider",
						status: "completed",
						parentGoalId: "G1",
						origin: "user",
						userTaskId: "u7",
					},
					{ id: "T2", title: "Add audit provider", status: "active", parentGoalId: "G1" },
				],
				activeRunIds: ["run-view-1"],
				requiredValidationEvidence: [
					{
						id: "V1",
						description: "Focused /view contracts pass",
						status: "pending",
						command: "npm test -- tests/contracts/view-artifacts.test.ts",
						artifactPath: "/tmp/view-artifacts.log",
						observedAt: "2026-06-11T12:06:00.000Z",
						notes: "waiting for implementation",
					},
				],
			},
		];
		const provider = new TaskLedgerArtifactProvider({
			stateDir,
			sessionMeta: meta,
			readSessionEntries: () => entries,
		});

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.id, "task-ledger:ledger-1");
		strictEqual(artifacts[0]?.category, "task-ledger");
		ok(artifacts[0]?.title.includes("Ship proof catalog"));
		ok(artifacts[0]?.title.includes("1/3 done"));
		ok(artifacts[0]?.searchText?.includes("run-view-1"));
		ok(artifacts[0]?.searchText?.includes("G1"));
		ok(artifacts[0]?.searchText?.includes("board-release-1"));
		ok(artifacts[0]?.searchText?.includes("user"));
		ok(artifacts[0]?.searchText?.includes("u7"));
		ok(artifacts[0]?.path?.endsWith("current.jsonl"));

		const loaded = await artifacts[0]?.load();
		const text = loaded?.lines.join("\n") ?? "";
		strictEqual(loaded?.format, "markdown");
		ok(text.includes("## Board Goals"), text);
		ok(text.includes("- board id: board-release-1"), text);
		ok(text.includes("- [active] G1 Ship proof catalog"), text);
		ok(text.includes("- origin: user"), text);
		ok(text.includes("- operator task: u7"), text);
		ok(text.includes("- run-view-1"), text);
		ok(text.includes("npm test -- tests/contracts/view-artifacts.test.ts"), text);
		ok(text.includes("- observed: 2026-06-11T12:06:00.000Z"), text);
	});

	it("lists and loads protected artifact session records", async () => {
		const stateDir = await scratchDir();
		const protectedPath = join(stateDir, "src", "locked.ts");
		const entries: SessionEntry[] = [
			{
				kind: "protectedArtifact",
				turnId: "protected-1",
				parentTurnId: "turn-1",
				timestamp: "2026-06-11T12:07:00.000Z",
				action: "protect",
				artifact: {
					path: protectedPath,
					protectedAt: "2026-06-11T12:06:30.000Z",
					reason: "validation passed",
					validationCommand: "npm test",
					validationExitCode: 0,
					source: "validation",
				},
				toolName: "write",
				toolCallId: "tool-call-1",
				runId: "run-view-1",
				correlationId: "corr-1",
			},
		];
		const provider = new ProtectedArtifactProvider({ stateDir, readSessionEntries: () => entries });

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.id, "protected:protected-1");
		strictEqual(artifacts[0]?.category, "protected-artifact");
		strictEqual(artifacts[0]?.runId, "run-view-1");
		strictEqual(artifacts[0]?.correlationId, "corr-1");
		strictEqual(artifacts[0]?.toolName, "write");
		ok(artifacts[0]?.title.includes("locked.ts"));
		strictEqual(artifacts[0]?.path, protectedPath);

		const loaded = await artifacts[0]?.load();
		const text = loaded?.lines.join("\n") ?? "";
		strictEqual(loaded?.format, "markdown");
		ok(text.includes(`- path: ${protectedPath}`), text);
		ok(text.includes("- source: validation"), text);
		ok(text.includes("- validation command: npm test"), text);
		ok(text.includes("- validation exit code: 0"), text);
		ok(text.includes("- tool name: write"), text);
		ok(text.includes("- run id: run-view-1"), text);
		ok(text.includes("- correlation id: corr-1"), text);
	});

	it("lists and loads current-session safety audit rows while surfacing malformed lines", async () => {
		const stateDir = await scratchDir();
		const meta = sessionMeta();
		await mkdir(join(stateDir, "audit"), { recursive: true });
		await writeFile(
			join(stateDir, "audit", "2026-06-11.jsonl"),
			[
				JSON.stringify({
					kind: "tool_call",
					ts: "2026-06-11T12:08:00.000Z",
					correlationId: "other-corr",
					tool: "read",
					actionClass: "inspect",
					decision: "allowed",
					sessionId: "other-session",
				}),
				"{not json",
				JSON.stringify({
					kind: "tool_call",
					ts: "2026-06-11T12:09:00.000Z",
					correlationId: "audit-corr",
					tool: "bash",
					actionClass: "write",
					decision: "blocked",
					sessionId: meta.id,
					runId: "run-view-1",
				}),
			].join("\n"),
		);
		const provider = new SafetyAuditArtifactProvider({ stateDir, sessionMeta: meta });

		const artifacts = await provider.list();
		const row = artifacts.find((artifact) => artifact.id === "audit:2026-06-11.jsonl:3");
		ok(row, "matching current-session audit row is listed");
		strictEqual(row.category, "audit");
		strictEqual(row.runId, "run-view-1");
		strictEqual(row.sessionId, meta.id);
		strictEqual(row.correlationId, "audit-corr");
		strictEqual(row.toolName, "bash");
		ok(row.title.includes("tool_call"), row.title);
		ok(row.title.includes("bash"), row.title);
		ok(row.title.includes("write"), row.title);
		ok(row.title.includes("run run-view-1"), row.title);
		ok(!artifacts.some((artifact) => artifact.id === "audit:2026-06-11.jsonl:1"), "other session row is skipped");
		ok(
			artifacts.some((artifact) => artifact.id === "audit:read-errors"),
			"malformed line is surfaced separately",
		);

		const loaded = await row.load();
		const text = loaded.lines.join("\n");
		strictEqual(loaded.format, "json");
		ok(text.includes('"file": "2026-06-11.jsonl"'), text);
		ok(text.includes('"line": 3'), text);
		ok(text.includes('"tool": "bash"'), text);
	});

	it("lists and loads minimal evidence bundles from the data dir", async () => {
		const stateDir = await scratchDir();
		const dataDir = await scratchDir();
		const evidenceId = await writeEvidenceFixture(dataDir);
		const provider = new EvidenceArtifactProvider({ stateDir, dataDir });

		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.id, evidenceId);
		strictEqual(artifacts[0]?.category, "evidence");
		strictEqual(artifacts[0]?.runId, "run-view-1");
		strictEqual(artifacts[0]?.sessionId, "session-1");
		ok(artifacts[0]?.searchText?.includes("blocked-tool"));
		ok(artifacts[0]?.title.includes("Evidence · run run-view-1"));
		ok(artifacts[0]?.path?.endsWith(join("evidence", evidenceId)));

		const loaded = await artifacts[0]?.load();
		const text = loaded?.lines.join("\n") ?? "";
		strictEqual(loaded?.format, "markdown");
		ok(text.includes("- evidence id: run-run-view-1-20260611T120000Z"), text);
		ok(text.includes("- source: run run-view-1"), text);
		ok(text.includes("- run ids: run-view-1"), text);
		ok(text.includes("- statuses: completed"), text);
		ok(text.includes("- targets: local"), text);
		ok(text.includes("- models: model-a"), text);
		ok(text.includes("- tool calls: 2"), text);
		ok(text.includes("- tool errors: 1"), text);
		ok(text.includes("- blocked tool calls: 1"), text);
		ok(text.includes("- tokens: 1.5k"), text);
		ok(text.includes("- cost: $0.01"), text);
		ok(text.includes("- protected artifacts: 1"), text);
		ok(text.includes("- wall time: 6.5s"), text);
		ok(text.includes("- blocked-tool"), text);
		ok(text.includes("- warn blocked-tool run run-view-1: 1 blocked tool call(s)"), text);
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
