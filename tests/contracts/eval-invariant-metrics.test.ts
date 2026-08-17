import { strictEqual } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type {
	RunOutcome,
	RunReceipt,
	RunReceiptAttestation,
	RunReceiptDraft,
} from "../../src/domains/dispatch/types.js";
import {
	createStreamInvariantFold,
	processInvariantMetrics,
	readRunJournal,
	receiptInvariantMetrics,
	receiptUsageMetrics,
	sessionInvariantMetrics,
	streamInvariantMetrics,
	writeBoundaryInvariantMetrics,
} from "../../src/domains/eval/metrics/invariants.js";
import { receiptProcessExitCode } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

interface SealOptions {
	outcome?: RunOutcome;
	exitCode?: number;
	/** Seal a worker attestation naming this pid; omitted leaves the receipt unattested. */
	attestedPid?: number;
	/** Sealed token total for this run; distinguishable values let a sum be checked rather than assumed. */
	tokenCount?: number;
	/** Sealed cost for this run. */
	costUsd?: number;
}

function attestation(pid: number): RunReceiptAttestation {
	return {
		protocolVersion: 3,
		host: "soak-host",
		pid,
		processGroupId: pid,
		settingsFingerprint: "fingerprint",
		specDigest: "digest",
		targetId: "mini",
		endpointIdentityHash: "e".repeat(64),
		wireModelId: "model",
		runtimeId: "llamacpp",
		toolSignature: "tools",
		resources: { labels: [], cpuCount: null, totalMemoryBytes: null, gpuCount: null, vramBytes: null },
	};
}

/** Seal one genuine, integrity-valid receipt into the isolated state directory. */
async function sealRun(options: SealOptions = {}): Promise<string> {
	const outcome: RunOutcome = options.outcome ?? "succeeded";
	const exitCode = options.exitCode ?? 0;
	const tokenCount = options.tokenCount ?? 12;
	const costUsd = options.costUsd ?? 0;
	const ledger = openLedger({ maxRuns: 20 });
	const envelope = ledger.create({
		agentId: "main-agent",
		executionRole: "builder",
		task: "soak invariant task",
		targetId: "mini",
		wireModelId: "model",
		runtimeId: "llamacpp",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp/soak-workspace",
	});
	const lineage = { parentRunId: null, rootRunId: envelope.id, attempt: 0, depth: 0 };
	const endedAt = "2026-08-06T12:00:01.000Z";
	ledger.update(envelope.id, {
		status: outcome === "succeeded" ? "completed" : "failed",
		outcome,
		outcomeDetail: null,
		lineage,
		endedAt,
		exitCode,
		tokenCount,
		inputTokenCount: 8,
		outputTokenCount: 4,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd,
	});
	const draft: RunReceiptDraft = {
		runId: envelope.id,
		agentId: "main-agent",
		executionRole: "builder",
		task: "soak invariant task",
		targetId: "mini",
		wireModelId: "model",
		runtimeId: "llamacpp",
		runtimeKind: "http",
		outcome,
		outcomeDetail: null,
		lineage,
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "manual",
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
		startedAt: envelope.startedAt,
		endedAt,
		exitCode,
		tokenCount,
		inputTokenCount: 8,
		outputTokenCount: 4,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		...(options.attestedPid === undefined ? {} : { attestation: attestation(options.attestedPid) }),
		sessionId: null,
	};
	ledger.recordReceipt(envelope.id, draft);
	await ledger.persist();
	return envelope.id;
}

function stateDirOf(root: string): string {
	return join(root, "state");
}

function receiptPath(root: string, runId: string): string {
	return join(stateDirOf(root), "receipts", `${runId}.json`);
}

function metricsFor(root: string, processExitCode = 0): Record<string, number | boolean> {
	return receiptInvariantMetrics(readRunJournal(stateDirOf(root)), processExitCode);
}

function usageMetricsFor(root: string): Record<string, number | boolean> {
	return receiptUsageMetrics(readRunJournal(stateDirOf(root)));
}

/** Every count this family emits. An unmeasured reading carries none of them. */
const RECEIPT_USAGE_COUNTS = ["receiptUsage.receiptCount", "receiptUsage.totalTokens", "receiptUsage.costUsd"] as const;

function assertNoUsageCounts(metrics: Record<string, number | boolean>): void {
	for (const key of RECEIPT_USAGE_COUNTS) strictEqual(key in metrics, false, `${key} must be absent, not zero`);
}

/** Seal one write-boundary verdict in the shape `writeWriteBoundaryVerdict` produces. */
function writeVerdict(root: string, rootId: string, window: string, overrides: Record<string, unknown>): void {
	const dir = join(stateDirOf(root), "write-boundaries", rootId);
	mkdirSync(dir, { recursive: true });
	const verdict = {
		version: 1,
		window,
		stepIds: ["leak"],
		allow: ["src/"],
		baselineHead: "b".repeat(40),
		capturedAt: "2026-08-06T12:00:00.000Z",
		checkedAt: "2026-08-06T12:00:01.000Z",
		changedPaths: [],
		violations: [],
		rolledBack: [],
		unrecoverable: [],
		status: "clean",
		reason: null,
		detail: null,
		digest: "d".repeat(64),
		...overrides,
	};
	writeFileSync(join(dir, `${window}.json`), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
}

function sessionEntry(role: "assistant" | "tool_call" | "tool_result", payload: Record<string, unknown> = {}): unknown {
	return {
		kind: "message",
		turnId: `turn-${role}-${JSON.stringify(payload)}`,
		parentTurnId: null,
		timestamp: "2026-08-06T12:00:00.000Z",
		role,
		payload,
	};
}

function writeSession(root: string, id: string, entries: ReadonlyArray<unknown>, header: unknown = undefined): void {
	const sessionDir = join(stateDirOf(root), "sessions", "cwd-hash", id);
	mkdirSync(sessionDir, { recursive: true });
	const sessionHeader =
		header === undefined
			? {
					type: "session",
					version: 3,
					id,
					timestamp: "2026-08-06T12:00:00.000Z",
					cwd: "/tmp/soak-workspace",
				}
			: header;
	writeFileSync(
		join(sessionDir, "current.jsonl"),
		`${[sessionHeader, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
}

function compactionSummary(): unknown {
	return {
		kind: "compactionSummary",
		turnId: "summary-1",
		parentTurnId: "kept-turn",
		timestamp: "2026-08-06T12:01:00.000Z",
		summary: "The earlier turn read planted-fact.txt.",
		trigger: "force",
		tokensBefore: 1200,
		tokensAfter: 240,
		messagesSummarized: 3,
		firstKeptTurnId: "kept-turn",
	};
}

function assistantEnd(responseId: string, totalTokens: number): unknown {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			responseId,
			usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens },
		},
	};
}

function agentEnd(totalTokens: number): unknown {
	return { type: "agent_end", messageCount: 1, usage: { totalTokens, measured: true } };
}

function streamMetrics(events: ReadonlyArray<unknown>): Record<string, number | boolean> {
	const fold = createStreamInvariantFold();
	fold.push(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	return streamInvariantMetrics(fold.invariants());
}

describe("contracts/eval invariant metrics", { concurrency: false }, () => {
	it("reads a sealed, authenticated, self-consistent run as intact", async () => {
		const isolated = await isolateClioEnv("clio-soak-intact-");
		try {
			await sealRun();

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.sealed"], true);
			strictEqual(metrics["receipt.count"], 1);
			strictEqual(metrics["receipt.rootCount"], 1);
			strictEqual(metrics["receipt.integrityValid"], true);
			strictEqual(metrics["receipt.outcomeMatchesExit"], true);
		} finally {
			isolated.restore();
		}
	});

	it("reports an unsealed run as unsealed and judges no seal it does not have", async () => {
		const isolated = await isolateClioEnv("clio-soak-unsealed-");
		try {
			// A journal that exists and is empty is an observation: the item ran
			// and sealed nothing. It is not an absence, and it is not success.
			mkdirSync(stateDirOf(isolated.dir), { recursive: true });

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.sealed"], false);
			strictEqual(metrics["receipt.count"], 0);
			strictEqual("receipt.integrityValid" in metrics, false);
			strictEqual("receipt.outcomeMatchesExit" in metrics, false);
		} finally {
			isolated.restore();
		}
	});

	it("leaves every invariant absent when there is no journal to read", () => {
		strictEqual(readRunJournal(join("/nonexistent-soak-state", "state")), null);
		strictEqual(Object.keys(receiptInvariantMetrics(null, 0)).length, 0);
	});

	it("reads batched tool calls and results as matched by toolCallId", async () => {
		const isolated = await isolateClioEnv("clio-soak-ledger-intact-");
		try {
			writeSession(isolated.dir, "session-1", [
				sessionEntry("assistant", { content: [{ type: "toolCall" }, { type: "toolCall" }] }),
				sessionEntry("tool_call", { toolCallId: "call-a", name: "read", args: {} }),
				sessionEntry("tool_call", { toolCallId: "call-b", name: "context", args: {} }),
				sessionEntry("tool_result", { toolCallId: "call-a", toolName: "read", result: "a" }),
				sessionEntry("tool_result", { toolCallId: "call-b", toolName: "context", result: "b" }),
				sessionEntry("assistant", { content: [{ type: "text", text: "done" }] }),
			]);

			const metrics = sessionInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["ledger.formatVersion"], 3);
			strictEqual(metrics["ledger.toolPairsUnmatched"], 0);
			strictEqual(metrics["ledger.assistantBetweenCallAndResult"], 0);
			strictEqual(metrics["ledger.sessionCount"], 1);
		} finally {
			isolated.restore();
		}
	});

	it("fails ledger.formatVersion on a version 2 transcript and takes the lowest version", async () => {
		const isolated = await isolateClioEnv("clio-soak-ledger-v2-");
		try {
			writeSession(isolated.dir, "session-v3", []);
			writeSession(isolated.dir, "session-v2", [], {
				type: "session",
				version: 2,
				id: "session-v2",
				timestamp: "2026-08-06T12:00:00.000Z",
				cwd: "/tmp/soak-workspace",
			});

			const metrics = sessionInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["ledger.formatVersion"], 2);
			// The diagnostic is capable of disagreeing with the one-session shape
			// expected from each current soak task.
			strictEqual(metrics["ledger.sessionCount"], 2);
		} finally {
			isolated.restore();
		}
	});

	it("fails ledger.toolPairsUnmatched on a dangling tool call", async () => {
		const isolated = await isolateClioEnv("clio-soak-ledger-dangling-");
		try {
			writeSession(isolated.dir, "session-1", [sessionEntry("tool_call", { toolCallId: "dangling" })]);
			strictEqual(sessionInvariantMetrics(stateDirOf(isolated.dir))["ledger.toolPairsUnmatched"], 1);
		} finally {
			isolated.restore();
		}
	});

	it("fails ledger.toolPairsUnmatched on an orphan tool result", async () => {
		const isolated = await isolateClioEnv("clio-soak-ledger-orphan-result-");
		try {
			writeSession(isolated.dir, "session-1", [sessionEntry("tool_result", { toolCallId: "orphan" })]);
			strictEqual(sessionInvariantMetrics(stateDirOf(isolated.dir))["ledger.toolPairsUnmatched"], 1);
		} finally {
			isolated.restore();
		}
	});

	it("fails ledger.assistantBetweenCallAndResult when the model completed another message first", async () => {
		const isolated = await isolateClioEnv("clio-soak-ledger-assistant-between-");
		try {
			writeSession(isolated.dir, "session-1", [
				sessionEntry("tool_call", { toolCallId: "late-result" }),
				sessionEntry("assistant", { content: [{ type: "text", text: "premature" }] }),
				sessionEntry("tool_result", { toolCallId: "late-result" }),
			]);

			const metrics = sessionInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["ledger.toolPairsUnmatched"], 0);
			strictEqual(metrics["ledger.assistantBetweenCallAndResult"], 1);
		} finally {
			isolated.restore();
		}
	});

	it("fails ledger.formatVersion closed when the transcript has no header", async () => {
		const isolated = await isolateClioEnv("clio-soak-ledger-no-header-");
		try {
			const sessionDir = join(stateDirOf(isolated.dir), "sessions", "cwd-hash", "session-1");
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(
				join(sessionDir, "current.jsonl"),
				`${JSON.stringify(sessionEntry("assistant", { content: [] }))}\n`,
				"utf8",
			);

			strictEqual(sessionInvariantMetrics(stateDirOf(isolated.dir))["ledger.formatVersion"], 0);
		} finally {
			isolated.restore();
		}
	});

	it("leaves ledger metrics absent when the item wrote no session", async () => {
		const isolated = await isolateClioEnv("clio-soak-ledger-absent-");
		try {
			mkdirSync(stateDirOf(isolated.dir), { recursive: true });
			strictEqual(Object.keys(sessionInvariantMetrics(stateDirOf(isolated.dir))).length, 0);
		} finally {
			isolated.restore();
		}
	});

	it("proves compaction continuity from successful reads of the same path on both sides of the summary", async () => {
		const isolated = await isolateClioEnv("clio-soak-continuity-intact-");
		try {
			writeSession(isolated.dir, "session-1", [
				sessionEntry("tool_call", { toolCallId: "read-before", name: "read", args: { path: "planted-fact.txt" } }),
				sessionEntry("tool_result", { toolCallId: "read-before", toolName: "read", isError: false, result: "fact" }),
				compactionSummary(),
				sessionEntry("tool_call", { toolCallId: "read-after", name: "read", args: { path: "planted-fact.txt" } }),
				sessionEntry("tool_result", { toolCallId: "read-after", toolName: "read", isError: false, result: "fact" }),
				sessionEntry("assistant", { content: [{ type: "text", text: "done" }] }),
			]);

			const metrics = sessionInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["continuity.compactionSummaryPresent"], true);
			strictEqual(metrics["continuity.answeredFromPreCompaction"], true);
			strictEqual(metrics["continuity.turnsAfterCompaction"], 3);
		} finally {
			isolated.restore();
		}
	});

	it("fails continuity promises when the transcript has no compaction summary", async () => {
		const isolated = await isolateClioEnv("clio-soak-continuity-no-summary-");
		try {
			writeSession(isolated.dir, "session-1", [
				sessionEntry("tool_call", { toolCallId: "read-before", name: "read", args: { path: "planted-fact.txt" } }),
				sessionEntry("tool_result", { toolCallId: "read-before", toolName: "read", isError: false, result: "fact" }),
			]);

			const metrics = sessionInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["continuity.compactionSummaryPresent"], false);
			strictEqual(metrics["continuity.answeredFromPreCompaction"], false);
			strictEqual(metrics["continuity.turnsAfterCompaction"], 0);
		} finally {
			isolated.restore();
		}
	});

	it("fails continuity.answeredFromPreCompaction when the final turn never rereads the planted path", async () => {
		const isolated = await isolateClioEnv("clio-soak-continuity-no-post-read-");
		try {
			writeSession(isolated.dir, "session-1", [
				sessionEntry("tool_call", { toolCallId: "read-before", name: "read", args: { path: "planted-fact.txt" } }),
				sessionEntry("tool_result", { toolCallId: "read-before", toolName: "read", isError: false, result: "fact" }),
				compactionSummary(),
				sessionEntry("assistant", { content: [{ type: "text", text: "did not read" }] }),
			]);

			const metrics = sessionInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["continuity.compactionSummaryPresent"], true);
			strictEqual(metrics["continuity.answeredFromPreCompaction"], false);
			strictEqual(metrics["continuity.turnsAfterCompaction"], 1);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.integrityValid when a sealed receipt is edited after sealing", async () => {
		const isolated = await isolateClioEnv("clio-soak-tampered-");
		try {
			const runId = await sealRun();
			strictEqual(metricsFor(isolated.dir)["receipt.integrityValid"], true);

			// One field moves and the digest does not. The receipt still parses,
			// still names its run, and no longer authenticates.
			const path = receiptPath(isolated.dir, runId);
			const receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
			receipt.tokenCount = 999_999;
			writeFileSync(path, JSON.stringify(receipt, null, 2), "utf8");

			strictEqual(metricsFor(isolated.dir)["receipt.integrityValid"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.integrityValid when the ledger no longer carries the run the receipt names", async () => {
		const isolated = await isolateClioEnv("clio-soak-no-envelope-");
		try {
			await sealRun();
			strictEqual(metricsFor(isolated.dir)["receipt.integrityValid"], true);

			// A receipt with no envelope has no authority to verify against.
			// Unauthenticated is a failure, never an absence.
			writeFileSync(join(stateDirOf(isolated.dir), "runs.json"), "[]", "utf8");

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.sealed"], true);
			strictEqual(metrics["receipt.integrityValid"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.integrityValid when a sealed receipt no longer parses", async () => {
		const isolated = await isolateClioEnv("clio-soak-unreadable-");
		try {
			const runId = await sealRun();

			writeFileSync(receiptPath(isolated.dir, runId), "{ truncated", "utf8");

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.count"], 1);
			strictEqual(metrics["receipt.sealed"], true);
			strictEqual(metrics["receipt.integrityValid"], false);
			strictEqual(metrics["receipt.outcomeMatchesExit"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.outcomeMatchesExit when a receipt claims success beside a nonzero exit", async () => {
		const isolated = await isolateClioEnv("clio-soak-outcome-drift-");
		try {
			await sealRun({ outcome: "succeeded", exitCode: 3 });

			const metrics = metricsFor(isolated.dir, 3);
			strictEqual(metrics["receipt.outcomeMatchesExit"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.outcomeMatchesExit when the sealed run disagrees with the process exit status", async () => {
		const isolated = await isolateClioEnv("clio-soak-process-drift-");
		try {
			// The receipt is internally consistent and integrity-valid. It says the
			// run succeeded; the process it ran in exited nonzero.
			await sealRun({ outcome: "succeeded", exitCode: 0 });
			strictEqual(metricsFor(isolated.dir, 0)["receipt.outcomeMatchesExit"], true);

			const metrics = metricsFor(isolated.dir, 1);
			strictEqual(metrics["receipt.integrityValid"], true);
			strictEqual(metrics["receipt.outcomeMatchesExit"], false);
		} finally {
			isolated.restore();
		}
	});

	it("reconciles a nested SIGINT receipt against the measured chaos exit instead of the clean harness exit", async () => {
		const isolated = await isolateClioEnv("clio-soak-chaos-exit-");
		try {
			await sealRun({ outcome: "canceled", exitCode: 130 });
			const journal = readRunJournal(stateDirOf(isolated.dir));
			strictEqual(receiptInvariantMetrics(journal, 0)["receipt.outcomeMatchesExit"], false);

			const processExitCode = receiptProcessExitCode({
				exitCode: 0,
				metrics: { "chaos.exitCode": 130 },
			});
			strictEqual(processExitCode, 130);
			strictEqual(receiptInvariantMetrics(journal, processExitCode)["receipt.outcomeMatchesExit"], true);
		} finally {
			isolated.restore();
		}
	});

	it("reports no orphan when the workers a receipt attested are gone", async () => {
		const isolated = await isolateClioEnv("clio-soak-no-orphan-");
		try {
			// A pid that has certainly exited: this process's own child, awaited.
			const dead = spawnSync(process.execPath, ["-e", ""]).pid ?? 1;
			await sealRun({ attestedPid: dead });

			const metrics = processInvariantMetrics(readRunJournal(stateDirOf(isolated.dir)));
			strictEqual(metrics["process.attestedWorkers"], 1);
			strictEqual(metrics["process.orphanedChildren"], 0);
		} finally {
			isolated.restore();
		}
	});

	it("fails process.orphanedChildren when an attested worker outlives its run", async () => {
		const isolated = await isolateClioEnv("clio-soak-orphan-");
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
		try {
			await sealRun({ attestedPid: child.pid ?? process.pid });

			const metrics = processInvariantMetrics(readRunJournal(stateDirOf(isolated.dir)));
			strictEqual(metrics["process.attestedWorkers"], 1);
			strictEqual(metrics["process.orphanedChildren"], 1);
		} finally {
			child.kill("SIGKILL");
			isolated.restore();
		}
	});

	it("leaves the process invariants absent when no receipt attested a worker", async () => {
		const isolated = await isolateClioEnv("clio-soak-no-attestation-");
		try {
			// The main-agent path runs in the orchestrator's own process and
			// attests no worker, so there is nothing here to judge.
			await sealRun();

			const metrics = processInvariantMetrics(readRunJournal(stateDirOf(isolated.dir)));
			strictEqual(Object.keys(metrics).length, 0);
		} finally {
			isolated.restore();
		}
	});

	it("reads an append-oriented stream as intact", () => {
		const metrics = streamMetrics([
			assistantEnd("resp-1", 100),
			{ type: "text_delta", contentIndex: 0, delta: "x" },
			assistantEnd("resp-2", 50),
			agentEnd(150),
		]);

		strictEqual(metrics["stream.messageUpdateCount"], 0);
		strictEqual(metrics["stream.cumulativeSnapshots"], 0);
		strictEqual(metrics["stream.usageDoubleCounted"], false);
		strictEqual(metrics["stream.segmentUsageMatchesMessages"], true);
	});

	it("counts an increment that arrives under a worker's event name without calling it a snapshot", () => {
		// The two headless surfaces name increments differently: the main agent
		// publishes `text_delta`, a worker publishes a slimmed `message_update`
		// whose only new field is the delta. Both keep the same promise.
		const metrics = streamMetrics([
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "The" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " fix" } },
			assistantEnd("resp-1", 100),
		]);

		strictEqual(metrics["stream.messageUpdateCount"], 2);
		strictEqual(metrics["stream.cumulativeSnapshots"], 0);
	});

	it("fails stream.cumulativeSnapshots when an update republishes the growing message", () => {
		const metrics = streamMetrics([
			{ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "e", partial: { role: "assistant", content: [] } },
			},
			assistantEnd("resp-1", 100),
		]);

		strictEqual(metrics["stream.cumulativeSnapshots"], 2);
	});

	it("fails stream.cumulativeSnapshots when a segment republishes its transcript", () => {
		// Every message in that transcript already crossed as its own
		// `message_end`; the summary is what a segment adds.
		const metrics = streamMetrics([
			assistantEnd("resp-1", 100),
			{ type: "agent_end", messages: [{ role: "assistant", content: [] }] },
		]);

		strictEqual(metrics["stream.cumulativeSnapshots"], 1);
	});

	it("fails stream.usageDoubleCounted when one provider response is completed twice", () => {
		const metrics = streamMetrics([assistantEnd("resp-1", 100), assistantEnd("resp-1", 100), agentEnd(100)]);

		strictEqual(metrics["stream.usageDoubleCounted"], true);
		// The two views disagree because one of them counted the response twice.
		strictEqual(metrics["stream.segmentUsageMatchesMessages"], false);
	});

	it("fails stream.segmentUsageMatchesMessages when the two accounts of one run disagree", () => {
		const metrics = streamMetrics([assistantEnd("resp-1", 100), assistantEnd("resp-2", 50), agentEnd(100)]);

		strictEqual(metrics["stream.usageDoubleCounted"], false);
		strictEqual(metrics["stream.segmentUsageMatchesMessages"], false);
	});

	it("sums several agent segments against the messages they span", () => {
		// A headless turn spans several segments; nothing may key on the last one.
		const metrics = streamMetrics([
			assistantEnd("resp-1", 100),
			agentEnd(100),
			assistantEnd("resp-2", 40),
			assistantEnd("resp-3", 60),
			agentEnd(100),
		]);

		strictEqual(metrics["stream.segmentUsageMatchesMessages"], true);
	});

	it("leaves the stream invariants absent when the stream carried nothing to judge", () => {
		const metrics = streamMetrics([{ type: "turn_start", startedAt: "2026-08-06T00:00:00.000Z" }]);

		strictEqual(metrics["stream.messageUpdateCount"], 0);
		strictEqual(metrics["stream.cumulativeSnapshots"], 0);
		strictEqual("stream.usageDoubleCounted" in metrics, false);
		strictEqual("stream.segmentUsageMatchesMessages" in metrics, false);
	});

	it("folds a stream split across arbitrary chunk boundaries", () => {
		const stream = [assistantEnd("resp-1", 100), agentEnd(100)].map((event) => JSON.stringify(event)).join("\n");
		const fold = createStreamInvariantFold();
		for (let index = 0; index < stream.length; index += 7) fold.push(stream.slice(index, index + 7));

		const metrics = streamInvariantMetrics(fold.invariants());
		strictEqual(metrics["stream.segmentUsageMatchesMessages"], true);
		strictEqual(metrics["stream.usageDoubleCounted"], false);
	});

	it("reads a sealed rollback verdict as a detected and repaired violation", async () => {
		const isolated = await isolateClioEnv("clio-soak-boundary-rolled-");
		try {
			writeVerdict(isolated.dir, "root-1", "wave-1", {
				status: "rolled-back",
				reason: "writes_boundary_violation",
				violations: ["out/leak.txt"],
			});

			const metrics = writeBoundaryInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["boundary.verdictCount"], 1);
			strictEqual(metrics["boundary.verdictSealed"], true);
			strictEqual(metrics["boundary.violationsDetected"], 1);
			strictEqual(metrics["boundary.violationsRolledBack"], 1);
			strictEqual(metrics["boundary.rollbackIncomplete"], 0);
		} finally {
			isolated.restore();
		}
	});

	it("counts a rollback it could not complete separately from one it could", async () => {
		const isolated = await isolateClioEnv("clio-soak-boundary-incomplete-");
		try {
			// A path already dirty when the snapshot was taken cannot be restored
			// from content git has. That is the honest failure, and it must stay
			// distinguishable from a clean rollback rather than reading as one.
			writeVerdict(isolated.dir, "root-1", "wave-1", {
				status: "rollback-incomplete",
				reason: "writes_boundary_violation",
				violations: ["out/leak.txt"],
				unrecoverable: [{ path: "out/leak.txt", reason: "path was dirty at snapshot" }],
			});

			const metrics = writeBoundaryInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["boundary.violationsDetected"], 1);
			strictEqual(metrics["boundary.rollbackIncomplete"], 1);
			strictEqual(metrics["boundary.violationsRolledBack"], 0);
		} finally {
			isolated.restore();
		}
	});

	it("fails boundary.verdictSealed when a verdict no longer parses", async () => {
		const isolated = await isolateClioEnv("clio-soak-boundary-corrupt-");
		try {
			writeVerdict(isolated.dir, "root-1", "wave-1", { status: "clean", reason: null });
			writeFileSync(join(stateDirOf(isolated.dir), "write-boundaries", "root-1", "wave-1.json"), "{ truncated", "utf8");

			const metrics = writeBoundaryInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["boundary.verdictCount"], 1);
			strictEqual(metrics["boundary.verdictSealed"], false, "a record that cannot be read cannot be audited");
		} finally {
			isolated.restore();
		}
	});

	it("fails boundary.verdictSealed when a verdict carries no baseline commit", async () => {
		const isolated = await isolateClioEnv("clio-soak-boundary-baseline-");
		try {
			// A verdict without the commit it was computed against measured the
			// checkout against nothing nameable.
			writeVerdict(isolated.dir, "root-1", "wave-1", { status: "clean", reason: null, baselineHead: "" });

			const metrics = writeBoundaryInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["boundary.verdictSealed"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails boundary.verdictSealed when a verdict carries no digest", async () => {
		const isolated = await isolateClioEnv("clio-soak-boundary-digest-");
		try {
			writeVerdict(isolated.dir, "root-1", "wave-1", { status: "clean", reason: null, digest: "" });

			const metrics = writeBoundaryInvariantMetrics(stateDirOf(isolated.dir));
			strictEqual(metrics["boundary.verdictSealed"], false);
		} finally {
			isolated.restore();
		}
	});

	it("leaves the boundary invariants absent when the run enforced no boundary", async () => {
		const isolated = await isolateClioEnv("clio-soak-boundary-absent-");
		try {
			// Absent, never zero: a run that enforced nothing answered none of
			// these questions, and a threshold on an absent metric fails closed.
			strictEqual(Object.keys(writeBoundaryInvariantMetrics(stateDirOf(isolated.dir))).length, 0);
		} finally {
			isolated.restore();
		}
	});

	it("sums what the receipts sealed, and says so with its own provenance", async () => {
		const isolated = await isolateClioEnv("clio-soak-usage-sum-");
		try {
			// Two attempts, deliberately distinguishable, so a sum is checked
			// rather than assumed from a single receipt.
			await sealRun({ tokenCount: 700, costUsd: 0.25 });
			await sealRun({ tokenCount: 300, costUsd: 0.75 });

			const metrics = usageMetricsFor(isolated.dir);
			strictEqual(metrics["receiptUsage.measured"], true);
			strictEqual(metrics["receiptUsage.receiptCount"], 2);
			strictEqual(metrics["receiptUsage.totalTokens"], 1000);
			strictEqual(metrics["receiptUsage.costUsd"], 1);
		} finally {
			isolated.restore();
		}
	});

	it("reports no receipt usage when a sealed receipt is edited after sealing", async () => {
		const isolated = await isolateClioEnv("clio-soak-usage-tampered-");
		try {
			const runId = await sealRun({ tokenCount: 700, costUsd: 0.25 });
			strictEqual(usageMetricsFor(isolated.dir)["receiptUsage.measured"], true);

			// The one edit that matters most here: the cost itself. The receipt
			// still parses and still names its run; its digest no longer covers
			// what it claims. A sum over that is a number nobody can vouch for.
			const path = receiptPath(isolated.dir, runId);
			const receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
			receipt.tokenCount = 999_999;
			writeFileSync(path, JSON.stringify(receipt, null, 2), "utf8");

			const metrics = usageMetricsFor(isolated.dir);
			strictEqual(metrics["receiptUsage.measured"], false);
			assertNoUsageCounts(metrics);
		} finally {
			isolated.restore();
		}
	});

	it("reports no receipt usage when a receipt file no longer parses", async () => {
		const isolated = await isolateClioEnv("clio-soak-usage-unreadable-");
		try {
			const runId = await sealRun({ tokenCount: 700, costUsd: 0.25 });
			await sealRun({ tokenCount: 300, costUsd: 0.75 });

			// A seal Clio wrote that can no longer be read is a broken seal. The
			// surviving receipt's counts are real, and reporting them alone would
			// under-report the run's cost as though nothing were missing.
			writeFileSync(receiptPath(isolated.dir, runId), "{ truncated", "utf8");

			const metrics = usageMetricsFor(isolated.dir);
			strictEqual(metrics["receiptUsage.measured"], false);
			assertNoUsageCounts(metrics);
		} finally {
			isolated.restore();
		}
	});

	it("reports no receipt usage when a receipt has no envelope to authenticate against", async () => {
		const isolated = await isolateClioEnv("clio-soak-usage-unauthenticated-");
		try {
			await sealRun({ tokenCount: 700, costUsd: 0.25 });
			// No envelope means no authority to verify against. An unauthenticated
			// receipt is a failure, never a cost to add up.
			writeFileSync(join(stateDirOf(isolated.dir), "runs.json"), "[]", "utf8");

			const metrics = usageMetricsFor(isolated.dir);
			strictEqual(metrics["receiptUsage.measured"], false);
			assertNoUsageCounts(metrics);
		} finally {
			isolated.restore();
		}
	});

	it("reports a run that sealed nothing as unmeasured rather than free", async () => {
		const isolated = await isolateClioEnv("clio-soak-usage-unsealed-");
		try {
			// A readable journal with no receipts is an observation: the item ran
			// and sealed nothing. That is unmeasured, and it is not a zero cost.
			mkdirSync(stateDirOf(isolated.dir), { recursive: true });

			const metrics = usageMetricsFor(isolated.dir);
			strictEqual(metrics["receiptUsage.measured"], false);
			assertNoUsageCounts(metrics);
		} finally {
			isolated.restore();
		}
	});

	it("leaves receipt usage absent when there is no journal to read", () => {
		// Absent, not false. A threshold on an absent metric fails closed; a
		// false would claim this pass looked and found nothing sealed.
		strictEqual(Object.keys(receiptUsageMetrics(null)).length, 0);
	});

	it("keeps stream-observed and receipt-sealed accounting as separate readings", async () => {
		const isolated = await isolateClioEnv("clio-soak-usage-provenance-");
		try {
			await sealRun({ tokenCount: 700, costUsd: 0.25 });

			// The two families never merge. A surface whose stdout carries no
			// `message_end` reports `tokens.measured: false` and still reads what
			// it sealed, and neither name ever answers for the other.
			const metrics = usageMetricsFor(isolated.dir);
			strictEqual("tokens.measured" in metrics, false);
			strictEqual("tokens.total" in metrics, false);
			strictEqual(metrics["receiptUsage.measured"], true);
		} finally {
			isolated.restore();
		}
	});

	it("ignores files that are not receipts and keeps a stray directory out of the count", async () => {
		const isolated = await isolateClioEnv("clio-soak-stray-");
		try {
			await sealRun();
			writeFileSync(join(stateDirOf(isolated.dir), "receipts", "notes.txt"), "not a receipt", "utf8");

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.count"], 1);
			strictEqual(metrics["receipt.integrityValid"], true);
		} finally {
			isolated.restore();
		}
	});
});
