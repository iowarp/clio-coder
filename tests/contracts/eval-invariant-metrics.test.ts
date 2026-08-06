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
	streamInvariantMetrics,
} from "../../src/domains/eval/metrics/invariants.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

interface SealOptions {
	outcome?: RunOutcome;
	exitCode?: number;
	/** Seal a worker attestation naming this pid; omitted leaves the receipt unattested. */
	attestedPid?: number;
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
		tokenCount: 12,
		inputTokenCount: 8,
		outputTokenCount: 4,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
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
		tokenCount: 12,
		inputTokenCount: 8,
		outputTokenCount: 4,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
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
		const isolated = isolateClioEnv("clio-soak-intact-");
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
		const isolated = isolateClioEnv("clio-soak-unsealed-");
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

	it("fails receipt.integrityValid when a sealed receipt is edited after sealing", async () => {
		const isolated = isolateClioEnv("clio-soak-tampered-");
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
		const isolated = isolateClioEnv("clio-soak-no-envelope-");
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
		const isolated = isolateClioEnv("clio-soak-unreadable-");
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
		const isolated = isolateClioEnv("clio-soak-outcome-drift-");
		try {
			await sealRun({ outcome: "succeeded", exitCode: 3 });

			const metrics = metricsFor(isolated.dir, 3);
			strictEqual(metrics["receipt.outcomeMatchesExit"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.outcomeMatchesExit when the sealed run disagrees with the process exit status", async () => {
		const isolated = isolateClioEnv("clio-soak-process-drift-");
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

	it("reports no orphan when the workers a receipt attested are gone", async () => {
		const isolated = isolateClioEnv("clio-soak-no-orphan-");
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
		const isolated = isolateClioEnv("clio-soak-orphan-");
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
		const isolated = isolateClioEnv("clio-soak-no-attestation-");
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

	it("ignores files that are not receipts and keeps a stray directory out of the count", async () => {
		const isolated = isolateClioEnv("clio-soak-stray-");
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
