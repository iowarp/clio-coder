import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { receiptFilePath, verifyReceiptFile } from "../../src/interactive/receipts-overlay.js";

const ORIGINAL_ENV = { ...process.env };

interface ReceiptFixture {
	runId: string;
	receiptPath: string;
	receipt: RunReceipt;
}

function failureReason(result: ReturnType<typeof verifyReceiptFile>): string {
	if (result.ok) throw new Error("expected receipt verification to fail");
	return result.reason;
}

async function createReceiptFixture(dataDir: string): Promise<ReceiptFixture> {
	const ledger = openLedger();
	const env = ledger.create({
		agentId: "worker",
		task: "implement integrity",
		endpointId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/repo",
	});
	const endedAt = "2026-04-24T00:00:01.000Z";
	ledger.update(env.id, {
		status: "completed",
		endedAt,
		exitCode: 0,
		tokenCount: 42,
		costUsd: 0.0001,
	});
	const receipt = ledger.recordReceipt(env.id, {
		runId: env.id,
		agentId: "worker",
		task: "implement integrity",
		endpointId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: env.startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 42,
		costUsd: 0.0001,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.1-test",
		piMonoVersion: "0.69.0",
		platform: "linux",
		nodeVersion: "v20.0.0",
		toolCalls: 0,
		toolStats: [],
		sessionId: null,
	});
	await ledger.persist();
	return {
		runId: env.id,
		receiptPath: receiptFilePath(dataDir, env.id),
		receipt,
	};
}

describe("receipt verify", () => {
	let scratch: string;
	let dataDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-receipt-verify-"));
		dataDir = join(scratch, "data");
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = dataDir;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("accepts a receipt whose integrity matches the run ledger", async () => {
		const fixture = await createReceiptFixture(dataDir);
		ok(/^[0-9a-f]{64}$/.test(fixture.receipt.integrity.digest));
		strictEqual(verifyReceiptFile(dataDir, fixture.runId).ok, true);
	});

	it("rejects a modified receipt", async () => {
		const fixture = await createReceiptFixture(dataDir);
		const tampered = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as Record<string, unknown>;
		tampered.task = "different task";
		writeFileSync(fixture.receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);

		match(failureReason(verifyReceiptFile(dataDir, fixture.runId)), /ledger mismatch: task/);
	});

	it("returns useful failures for missing and malformed receipts", () => {
		strictEqual(failureReason(verifyReceiptFile(dataDir, "missing")), "receipt file not found");

		const malformedPath = receiptFilePath(dataDir, "malformed");
		mkdirSync(join(dataDir, "receipts"), { recursive: true });
		writeFileSync(malformedPath, "{");
		match(failureReason(verifyReceiptFile(dataDir, "malformed")), /^invalid json:/);
	});

	it("rejects a legacy receipt without integrity", async () => {
		const fixture = await createReceiptFixture(dataDir);
		const legacy = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as Record<string, unknown>;
		delete legacy.integrity;
		writeFileSync(fixture.receiptPath, `${JSON.stringify(legacy, null, 2)}\n`);

		strictEqual(failureReason(verifyReceiptFile(dataDir, fixture.runId)), "missing field: integrity");
	});
});
