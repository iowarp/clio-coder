import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";

const ORIGINAL_ENV = { ...process.env };

describe("dispatch/ledger", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-ledger-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
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

	it("create + get returns the envelope", () => {
		const ledger = openLedger();
		const env = ledger.create({
			agentId: "a",
			task: "t",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "native",
			sessionId: null,
			cwd: process.cwd(),
		});
		ok(env.id.length > 0);
		strictEqual(env.status, "queued");
		const got = ledger.get(env.id);
		strictEqual(got?.id, env.id);
	});

	it("update patches fields", () => {
		const ledger = openLedger();
		const env = ledger.create({
			agentId: "a",
			task: "t",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "native",
			sessionId: null,
			cwd: process.cwd(),
		});
		const updated = ledger.update(env.id, { status: "running", pid: 1234 });
		strictEqual(updated?.status, "running");
		strictEqual(updated?.pid, 1234);
	});

	it("list filters by status", () => {
		const ledger = openLedger();
		const a = ledger.create({
			agentId: "a",
			task: "t1",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "native",
			sessionId: null,
			cwd: ".",
		});
		const b = ledger.create({
			agentId: "a",
			task: "t2",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "native",
			sessionId: null,
			cwd: ".",
		});
		ledger.update(a.id, { status: "completed", endedAt: new Date().toISOString(), exitCode: 0 });
		const completed = ledger.list({ status: "completed" });
		strictEqual(completed.length, 1);
		strictEqual(completed[0]?.id, a.id);
		ok(b.id !== a.id);
	});

	it("persist writes runs.json and reload recovers", async () => {
		const ledger = openLedger();
		const env = ledger.create({
			agentId: "a",
			task: "persisted",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "native",
			sessionId: null,
			cwd: ".",
		});
		await ledger.persist();
		const reopened = openLedger();
		strictEqual(reopened.get(env.id)?.task, "persisted");
	});

	it("maxRuns caps the ledger ring", async () => {
		const ledger = openLedger({ maxRuns: 3 });
		for (let i = 0; i < 5; i++) {
			ledger.create({
				agentId: "a",
				task: `t${i}`,
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				runtime: "native",
				sessionId: null,
				cwd: ".",
			});
		}
		await ledger.persist();
		const reopened = openLedger();
		strictEqual(reopened.list().length, 3);
	});

	it("recordReceipt writes to receipts dir", () => {
		const ledger = openLedger();
		const env = ledger.create({
			agentId: "a",
			task: "t",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "native",
			sessionId: null,
			cwd: ".",
		});
		ledger.recordReceipt(env.id, {
			runId: env.id,
			agentId: "a",
			task: "t",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			runtime: "native",
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			exitCode: 0,
			tokenCount: 0,
			costUsd: 0,
			compiledPromptHash: null,
			staticCompositionHash: null,
			clioVersion: "0.0.0",
			piMonoVersion: "0.0.0",
			platform: process.platform,
			nodeVersion: process.version,
			toolCalls: 0,
			sessionId: null,
		});
		const receiptPath = join(scratch, "data", "receipts", `${env.id}.json`);
		ok(existsSync(receiptPath));
	});
});
