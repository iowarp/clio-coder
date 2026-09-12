import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("dispatch run ledger state", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-dispatch-state-");
	});

	afterEach(() => scratch.restore());

	it("loads legacy unversioned records as version 1 and skips version 2 records", async () => {
		const stateDir = clioStateDir();
		mkdirSync(stateDir, { recursive: true });
		const runsPath = join(stateDir, "runs.json");
		const legacyRecord = {
			id: "run-legacy",
			agentId: "coder",
			executionRole: "builder",
			task: "legacy task",
			targetId: "local",
			wireModelId: "model-a",
			runtimeId: "openai",
			runtimeKind: "http",
			startedAt: "2026-06-25T12:00:00.000Z",
			endedAt: "2026-06-25T12:00:05.000Z",
			status: "completed",
			exitCode: 0,
			pid: null,
			heartbeatAt: null,
			receiptPath: null,
			sessionId: "session-1",
			cwd: "/workspace",
			tokenCount: 42,
			costUsd: 0.01,
		};
		const futureRecord = {
			...legacyRecord,
			version: 2,
			id: "run-future",
		};
		const v1Record = {
			...legacyRecord,
			version: 1,
			id: "run-v1",
		};
		writeFileSync(runsPath, JSON.stringify([legacyRecord, futureRecord, v1Record], null, 2), "utf8");

		const ledger = openLedger();
		const listed = ledger.list();
		strictEqual(listed.length, 2);
		strictEqual(listed[0]?.id, "run-legacy");
		strictEqual(listed[0]?.version, 1);
		strictEqual(listed[1]?.id, "run-v1");
		strictEqual(listed[1]?.version, 1);
		strictEqual(ledger.get("run-future"), null);
	});

	it("always stamps version 1 when creating and persisting records", async () => {
		const ledger = openLedger();
		const created = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "new task",
			targetId: "local",
			wireModelId: "model-a",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: scratch.dir,
		});
		strictEqual(created.version, 1);
		await ledger.persist();

		const reopened = openLedger();
		const persisted = reopened.get(created.id);
		ok(persisted !== null);
		strictEqual(persisted.version, 1);
	});
});
