import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { isSessionEntry, isSessionHeader } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { openSession, readSessionFileEntries, writeJsonlFileAtomic } from "../../src/engine/session.js";

const ORIGINAL_ENV = { ...process.env };

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

describe("contracts/persistence", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-persistence-"));
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

	it("creates, retrieves, and persists ledger runs and receipts", async () => {
		const ledger = openLedger({ maxRuns: 10 });
		const env = ledger.create({
			agentId: "coder",
			task: "persistence task",
			endpointId: "anthropic-default",
			wireModelId: "claude-sonnet-4-6",
			runtimeId: "anthropic",
			runtimeKind: "http" as const,
			sessionId: null,
			cwd: process.cwd(),
		});

		ok(env.id.length > 0);
		strictEqual(env.status, "queued");

		const got = ledger.get(env.id);
		strictEqual(got?.id, env.id);

		// Persist runs.json
		await ledger.persist();
		const reopened = openLedger();
		strictEqual(reopened.get(env.id)?.task, "persistence task");

		// Record a receipt
		ledger.update(env.id, {
			status: "completed",
			endedAt: "2026-04-24T00:00:01.000Z",
			exitCode: 0,
			tokenCount: 0,
			costUsd: 0,
		});

		const receipt = ledger.recordReceipt(env.id, {
			runId: env.id,
			agentId: "coder",
			task: "persistence task",
			endpointId: "anthropic-default",
			wireModelId: "claude-sonnet-4-6",
			runtimeId: "anthropic",
			runtimeKind: "http" as const,
			startedAt: env.startedAt,
			endedAt: "2026-04-24T00:00:01.000Z",
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
			toolStats: [],
			sessionId: null,
		});

		const receiptPath = join(scratch, "data", "receipts", `${env.id}.json`);
		ok(existsSync(receiptPath));
		const written = JSON.parse(readFileSync(receiptPath, "utf8")) as typeof receipt;
		strictEqual(written.integrity.digest, receipt.integrity.digest);
	});

	it("validates session headers and entry serialization", () => {
		const header = {
			type: "session",
			version: 2,
			id: "sess-1",
			timestamp: "2026-04-17T00:00:00.000Z",
			cwd: "/tmp/project",
		};
		strictEqual(isSessionHeader(header), true);
		strictEqual(isSessionHeader({ type: "invalid" }), false);

		const messageEntry = {
			kind: "message",
			turnId: "t1",
			parentTurnId: null,
			timestamp: "2026-04-17T00:00:00.000Z",
			role: "user",
			payload: { text: "hello" },
		};
		strictEqual(isSessionEntry(messageEntry), true);
		strictEqual(isSessionEntry({ kind: "invalid" }), false);
	});

	it("handles atomic JSONL file writes and skips corrupt trailing lines", () => {
		const path = join(scratch, "session.jsonl");
		writeJsonlFileAtomic(path, [{ type: "session", version: 2 }]);

		ok(existsSync(path));
		const records = readSessionFileEntries(path);
		deepStrictEqual(records, [{ type: "session", version: 2 }]);

		// Append corruption
		writeFileSync(path, `${readFileSync(path, "utf8")}{corrupt\n`, "utf8");
		const recovered = readSessionFileEntries(path, { onWarning: () => {} });
		deepStrictEqual(recovered, [{ type: "session", version: 2 }]);
	});

	it("supports session fork and path-history resume primitives", () => {
		const bundle = createSessionBundle(stubContext());
		const contract = bundle.contract;

		const _parent = contract.create({ cwd: scratch });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "first question" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "first reply" } });
		const _u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "alternative branch" } });

		// Fork the session at the first assistant response
		const forkedMeta = contract.fork(a1.id);
		const reader = openSession(forkedMeta.id);

		// Verified child session has parent pointer and pre-fork history
		const header = reader.header();
		ok(header);
		strictEqual(header.parentTurnId, a1.id);

		const turns = reader.turns();
		strictEqual(turns.length, 2);
		strictEqual((turns[0] as any)?.kind, "message");
		strictEqual((turns[0] as any).payload.text, "first question");
		strictEqual((turns[1] as any).payload.text, "first reply");
	});
});
