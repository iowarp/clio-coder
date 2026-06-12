/**
 * `clio evidence build` verdict contract (bt-02 finding 3): the operator-facing
 * verdict line and exit code must tell the truth about receipt integrity. The
 * artifact is still written (the finding is part of the evidence), but a
 * corrupted receipt must fail the command, and a clean modern receipt (with
 * outcome, lineage, and token splits) must keep verifying.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runEvidenceCommand } from "../../src/cli/evidence.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { buildEvidence } from "../../src/domains/evidence/index.js";

function withIsolatedClioHome<T>(fn: (scratch: string) => T | Promise<T>): Promise<T> {
	const originalEnv = { ...process.env };
	const scratch = mkdtempSync(join(tmpdir(), "clio-evidence-build-"));
	process.env.CLIO_HOME = scratch;
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
	return Promise.resolve()
		.then(() => fn(scratch))
		.finally(() => {
			for (const k of Object.keys(process.env)) {
				if (!(k in originalEnv)) Reflect.deleteProperty(process.env, k);
			}
			for (const [k, v] of Object.entries(originalEnv)) {
				if (v !== undefined) process.env[k] = v;
			}
			rmSync(scratch, { recursive: true, force: true });
			resetXdgCache();
		});
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, stderr };
	} finally {
		process.stderr.write = original;
	}
}

/** Seal a finalized run + receipt the way the dispatch finalizer does. */
async function sealRun(): Promise<{ runId: string; receiptPath: string }> {
	const ledger = openLedger();
	const envelope = ledger.create({
		agentId: "coder",
		task: "evidence fixture task",
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: "openai-completions",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp",
	});
	const endedAt = new Date().toISOString();
	ledger.update(envelope.id, {
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: "completed without executing any tools",
		endedAt,
		exitCode: 0,
		tokenCount: 2795,
		inputTokenCount: 2606,
		outputTokenCount: 189,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
	});
	const receipt = ledger.recordReceipt(envelope.id, {
		runId: envelope.id,
		agentId: "coder",
		task: "evidence fixture task",
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: "openai-completions",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeDetail: "completed without executing any tools",
		startedAt: envelope.startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 2795,
		inputTokenCount: 2606,
		outputTokenCount: 189,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		toolActivity: { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false },
		sessionId: null,
	});
	await ledger.persist();
	const receiptPath = ledger.get(envelope.id)?.receiptPath;
	if (!receiptPath) throw new Error("fixture receipt path missing");
	strictEqual(receipt.integrity.version, 2);
	return { runId: envelope.id, receiptPath };
}

function readJsonl(path: string): unknown[] {
	const text = readFileSync(path, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

describe("contracts/evidence-build", () => {
	it("exits 0 on a clean modern receipt and 1 with the integrity failure printed on a corrupted one", async () => {
		await withIsolatedClioHome(async () => {
			const { runId, receiptPath } = await sealRun();

			const clean = await captureStderr(() => runEvidenceCommand(["build", "--run", runId]));
			strictEqual(clean.result, 0, `clean build failed: ${clean.stderr}`);

			// Flip one digested field; the artifact must still build, but the
			// verdict line and exit code must report the integrity failure.
			const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { inputTokenCount: number };
			receipt.inputTokenCount += 1;
			writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

			const corrupted = await captureStderr(() => runEvidenceCommand(["build", "--run", runId]));
			strictEqual(corrupted.result, 1);
			ok(corrupted.stderr.includes("receipt integrity"), corrupted.stderr);
			ok(corrupted.stderr.includes(runId), corrupted.stderr);
		});
	});

	it("treats classified audit rows as non-final and denied rows as blocked tool events", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const { runId } = await sealRun();
			const dataDir = join(scratch, "data");
			const auditDir = join(dataDir, "audit");
			mkdirSync(auditDir, { recursive: true });
			const ts = new Date().toISOString();
			const auditFixture = [
				{
					kind: "tool_call",
					ts,
					correlationId: "audit-classified",
					runId,
					tool: "write",
					actionClass: "write",
					decision: "classified",
					reasons: ["classified before autonomy"],
				},
				{
					kind: "tool_call",
					ts,
					correlationId: "audit-denied",
					runId,
					tool: "write",
					actionClass: "write",
					decision: "denied",
					reasons: ["Clio is at autonomy read-only: write actions are denied without prompting."],
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n");
			writeFileSync(join(auditDir, `${ts.slice(0, 10)}.jsonl`), `${auditFixture}\n`);

			const result = await buildEvidence({ dataDir, runId });
			const auditRows = readJsonl(join(result.directory, "audit-linked.jsonl"));
			const toolEvents = readJsonl(join(result.directory, "tool-events.jsonl")) as Array<Record<string, unknown>>;

			strictEqual(auditRows.length, 2);
			strictEqual(toolEvents.length, 1);
			strictEqual(toolEvents[0]?.decision, "denied");
			strictEqual(toolEvents[0]?.blocked, 1);
			strictEqual(toolEvents[0]?.ok, 0);
		});
	});
});
