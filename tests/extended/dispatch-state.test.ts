import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { measuredRunSpend } from "../harness/receipt.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("dispatch run ledger state", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-dispatch-state-");
	});

	afterEach(() => scratch.restore());

	it("reads only rows whose spend is one fact per quantity and replaces a file in any other shape (#434)", async () => {
		const stateDir = clioStateDir();
		mkdirSync(stateDir, { recursive: true });
		const runsPath = join(stateDir, "runs.json");
		const row = {
			version: 1,
			id: "run-v1",
			agentId: "coder",
			executionRole: "builder",
			task: "task",
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
			sessionId: "session-1",
			cwd: "/workspace",
			...measuredRunSpend({ input: 20, output: 22 }, 0.01),
		};
		writeFileSync(runsPath, JSON.stringify([row], null, 2), "utf8");
		strictEqual(openLedger().get("run-v1")?.id, "run-v1");
		// A row that carries numbers where the facts belong makes the whole file foreign: it is not read.
		const { spend: _spend, ...numeric } = row;
		writeFileSync(runsPath, JSON.stringify([row, { ...numeric, id: "run-old", tokenCount: 42, costUsd: 0.01 }]), "utf8");
		strictEqual(openLedger().list().length, 0);
		writeFileSync(runsPath, JSON.stringify([{ ...row, version: 2 }]), "utf8");
		strictEqual(openLedger().list().length, 0);
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
