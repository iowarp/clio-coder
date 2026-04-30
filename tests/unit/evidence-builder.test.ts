import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { ToolCallStat } from "../../src/domains/dispatch/types.js";
import { buildEvidence, inspectEvidence, listEvidenceOverviews } from "../../src/domains/evidence/index.js";

const ORIGINAL_ENV = { ...process.env };

interface EvidenceFixture {
	runId: string;
	dataDir: string;
	startedAt: string;
	endedAt: string;
	sessionId: string | null;
}

describe("evidence builder", () => {
	let scratch: string;
	let dataDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-evidence-"));
		dataDir = join(scratch, "data");
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = dataDir;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("builds deterministic run evidence from ledger and receipt artifacts", async () => {
		const fixture = await createRunFixture({
			task: "npm test fails on blocked tool",
			status: "failed",
			exitCode: 1,
			toolStats: [
				{
					tool: "bash",
					count: 2,
					ok: 1,
					errors: 1,
					blocked: 1,
					totalDurationMs: 120,
				},
			],
		});

		const first = await buildEvidence({ dataDir: fixture.dataDir, runId: fixture.runId });
		const second = await buildEvidence({ dataDir: fixture.dataDir, runId: fixture.runId });
		strictEqual(first.evidenceId, second.evidenceId);
		deepStrictEqual(second.overview, first.overview);
		strictEqual(first.overview.totals.runs, 1);
		strictEqual(first.overview.totals.receipts, 1);
		strictEqual(first.overview.totals.toolCalls, 2);
		strictEqual(first.overview.totals.blockedToolCalls, 1);
		deepStrictEqual(first.overview.tags, ["blocked-tool", "test-failure"]);
		ok(existsSync(join(first.directory, "overview.json")));
		ok(existsSync(join(first.directory, "trace.raw.jsonl")));
		ok(existsSync(join(first.directory, "trace.cleaned.jsonl")));
		ok(existsSync(join(first.directory, "tool-events.jsonl")));
		ok(existsSync(join(first.directory, "audit-linked.jsonl")));
		ok(existsSync(join(first.directory, "receipt.json")));
		ok(existsSync(join(first.directory, "protected-artifacts.json")));
		ok(existsSync(join(first.directory, "findings.json")));
		ok(existsSync(join(first.directory, "findings.md")));

		const toolEvents = readFileSync(join(first.directory, "tool-events.jsonl"), "utf8");
		ok(toolEvents.includes('"tool":"bash"'));
		ok(toolEvents.includes('"blocked":1'));

		const inspected = await inspectEvidence(fixture.dataDir, first.evidenceId);
		strictEqual(inspected.overview.evidenceId, first.evidenceId);
		strictEqual(inspected.findings.length, 2);

		const listed = await listEvidenceOverviews(fixture.dataDir);
		deepStrictEqual(
			listed.map((overview) => overview.evidenceId),
			[first.evidenceId],
		);
	});

	it("aggregates session evidence from runs that share a session id", async () => {
		const sessionId = "session-123";
		const first = await createRunFixture({ task: "first task", sessionId });
		const second = await createRunFixture({ task: "second task", sessionId });

		const result = await buildEvidence({ dataDir: first.dataDir, sessionId });

		strictEqual(result.overview.source.kind, "session");
		strictEqual(result.overview.sessionId, sessionId);
		strictEqual(result.overview.totals.runs, 2);
		strictEqual(result.overview.totals.receipts, 2);
		deepStrictEqual(result.overview.runIds, [first.runId, second.runId].sort());
	});

	it("links session entries into transcript and per-call tool events", async () => {
		const sessionId = "session-linked";
		const fixture = await createRunFixture({
			task: "inspect linked transcript",
			sessionId,
			toolStats: [
				{
					tool: "bash",
					count: 1,
					ok: 1,
					errors: 0,
					blocked: 0,
					totalDurationMs: 42,
				},
			],
		});
		writeSessionEntries(fixture.dataDir, sessionId, [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-04-29T00:00:00.100Z",
				role: "user",
				payload: { text: "Please inspect the failing test" },
			},
			{
				kind: "message",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: "2026-04-29T00:00:00.200Z",
				role: "assistant",
				payload: { text: "I will run the test." },
			},
			{
				kind: "message",
				turnId: "tc1",
				parentTurnId: "a1",
				timestamp: "2026-04-29T00:00:00.300Z",
				role: "tool_call",
				payload: { toolCallId: "call-1", name: "bash", args: { command: "npm test" } },
			},
			{
				kind: "message",
				turnId: "tr1",
				parentTurnId: "tc1",
				timestamp: "2026-04-29T00:00:00.400Z",
				role: "tool_result",
				payload: { toolCallId: "call-1", toolName: "bash", result: "tests passed", isError: false },
			},
		]);

		const result = await buildEvidence({ dataDir: fixture.dataDir, runId: fixture.runId });

		const transcript = readFileSync(join(result.directory, "transcript.md"), "utf8");
		ok(transcript.includes("## Linked Session Transcript"));
		ok(transcript.includes("user: Please inspect the failing test"));
		ok(transcript.includes("tool_call bash id=call-1"));
		strictEqual(result.overview.totals.sessionEntries, 4);
		strictEqual(result.overview.totals.linkedToolEvents, 1);
		ok(result.overview.tags.includes("session-linked"));

		const toolRows = readJsonl(join(result.directory, "tool-events.jsonl"));
		strictEqual(toolRows.length, 1);
		const row = toolRows[0];
		ok(isRecord(row));
		strictEqual(row.source, "session-entry");
		strictEqual(row.tool, "bash");
		strictEqual(row.toolCallId, "call-1");
		strictEqual(row.ok, 1);
	});

	it("links protected artifact session entries into evidence artifacts", async () => {
		const sessionId = "session-protected";
		const fixture = await createRunFixture({ task: "validate output", sessionId });
		writeSessionEntries(fixture.dataDir, sessionId, [
			{
				kind: "protectedArtifact",
				turnId: "pa1",
				parentTurnId: null,
				timestamp: "2026-04-29T00:00:00.300Z",
				action: "protect",
				toolName: "bash",
				toolCallId: "call-test",
				runId: fixture.runId,
				correlationId: "corr-test",
				artifact: {
					path: "dist/report.txt",
					protectedAt: "2026-04-29T00:00:00.300Z",
					reason: "validation command passed",
					validationCommand: "npm test",
					validationExitCode: 0,
					source: "middleware",
				},
			},
		]);

		const result = await buildEvidence({ dataDir: fixture.dataDir, runId: fixture.runId });

		strictEqual(result.overview.totals.protectedArtifacts, 1);
		ok(result.overview.tags.includes("protected-artifact"));
		const transcript = readFileSync(join(result.directory, "transcript.md"), "utf8");
		ok(transcript.includes("protectedArtifact protect: tool=bash dist/report.txt"), transcript);
		ok(transcript.includes("validation=npm test exit=0"), transcript);

		const protectedFile = readJson(join(result.directory, "protected-artifacts.json"));
		ok(isRecord(protectedFile));
		strictEqual(protectedFile.version, 1);
		ok(Array.isArray(protectedFile.artifacts));
		ok(Array.isArray(protectedFile.events));
		const artifact = protectedFile.artifacts[0];
		ok(isRecord(artifact));
		strictEqual(artifact.path, "dist/report.txt");
		strictEqual(artifact.validationCommand, "npm test");
		const event = protectedFile.events[0];
		ok(isRecord(event));
		strictEqual(event.toolCallId, "call-test");
		strictEqual(event.sourceRunId, fixture.runId);
	});

	it("links audit rows by run id, session id, and timestamp plus tool metadata", async () => {
		const sessionId = "session-audit";
		const fixture = await createRunFixture({
			task: "inspect linked audit rows",
			sessionId,
			toolStats: [
				{
					tool: "bash",
					count: 1,
					ok: 1,
					errors: 0,
					blocked: 0,
					totalDurationMs: 5,
				},
			],
		});
		writeAuditRows(fixture.dataDir, [
			{
				kind: "abort",
				ts: "2026-04-29T00:00:00.500Z",
				correlationId: "audit-run",
				source: "dispatch_abort",
				runId: fixture.runId,
				startedAt: fixture.startedAt,
				elapsedMs: 500,
			},
			{
				kind: "session_park",
				ts: "2026-04-29T00:00:00.600Z",
				correlationId: "audit-session",
				sessionId,
				reason: "close",
			},
			{
				kind: "tool_call",
				ts: "2026-04-29T00:00:00.700Z",
				correlationId: "audit-tool",
				tool: "bash",
				actionClass: "read",
				decision: "allowed",
				reasons: ["test"],
				args: { command: "npm test" },
			},
		]);

		const result = await buildEvidence({ dataDir: fixture.dataDir, runId: fixture.runId });

		strictEqual(result.overview.totals.auditRows, 3);
		ok(result.overview.tags.includes("audit-linked"));
		ok(result.overview.tags.includes("best-effort-link"));
		const linkedRows = readJsonl(join(result.directory, "audit-linked.jsonl"));
		deepStrictEqual(
			linkedRows.map((row) => (isRecord(row) ? row.linkKind : null)),
			["run-id", "session-id", "timestamp-tool"],
		);
		const toolRows = readJsonl(join(result.directory, "tool-events.jsonl"));
		strictEqual(toolRows.length, 1);
		const toolRow = toolRows[0];
		ok(isRecord(toolRow));
		strictEqual(toolRow.source, "audit-row");
		strictEqual(toolRow.tool, "bash");
		strictEqual(toolRow.decision, "allowed");
	});

	it("does not fail when linked audit and session files are missing", async () => {
		const fixture = await createRunFixture({ task: "missing linked data", sessionId: "missing-session" });

		const result = await buildEvidence({ dataDir: fixture.dataDir, runId: fixture.runId });

		strictEqual(result.overview.totals.sessionEntries, 0);
		strictEqual(result.overview.totals.auditRows, 0);
		ok(result.overview.tags.includes("session-missing"));
		strictEqual(readFileSync(join(result.directory, "audit-linked.jsonl"), "utf8"), "");
	});

	it("reports missing run ids without creating evidence", async () => {
		await createRunFixture({ task: "seed ledger" });
		await rejects(() => buildEvidence({ dataDir, runId: "missing-run" }), /run not found: missing-run/);
	});
});

async function createRunFixture(options: {
	task: string;
	status?: "completed" | "failed";
	exitCode?: number;
	sessionId?: string | null;
	toolStats?: ToolCallStat[];
	startedAt?: string;
	endedAt?: string;
}): Promise<EvidenceFixture> {
	const ledger = openLedger();
	const envelope = ledger.create({
		agentId: "scout",
		task: options.task,
		endpointId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		sessionId: options.sessionId ?? null,
		cwd: "/repo",
	});
	const startedAt = options.startedAt ?? "2026-04-29T00:00:00.000Z";
	const endedAt = options.endedAt ?? "2026-04-29T00:00:02.000Z";
	const exitCode = options.exitCode ?? 0;
	const toolStats = options.toolStats ?? [];
	const toolCalls = toolStats.reduce((total, stat) => total + stat.count, 0);
	ledger.update(envelope.id, {
		startedAt,
		status: options.status ?? "completed",
		endedAt,
		exitCode,
		tokenCount: 12,
		costUsd: 0.01,
	});
	ledger.recordReceipt(envelope.id, {
		runId: envelope.id,
		agentId: "scout",
		task: options.task,
		endpointId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt,
		endedAt,
		exitCode,
		tokenCount: 12,
		costUsd: 0.01,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.3-test",
		piMonoVersion: "0.70.2",
		platform: "linux",
		nodeVersion: "v22.0.0",
		toolCalls,
		toolStats,
		sessionId: options.sessionId ?? null,
	});
	await ledger.persist();
	const currentDataDir = process.env.CLIO_DATA_DIR;
	if (currentDataDir === undefined) throw new Error("CLIO_DATA_DIR unset");
	return { runId: envelope.id, dataDir: currentDataDir, startedAt, endedAt, sessionId: options.sessionId ?? null };
}

function writeSessionEntries(
	dataDir: string,
	sessionId: string,
	entries: ReadonlyArray<Record<string, unknown>>,
): void {
	const dir = join(dataDir, "sessions", "cwdhash", sessionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "current.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function writeAuditRows(dataDir: string, rows: ReadonlyArray<Record<string, unknown>>): void {
	const dir = join(dataDir, "audit");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "2026-04-29.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function readJsonl(path: string): unknown[] {
	const raw = readFileSync(path, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
