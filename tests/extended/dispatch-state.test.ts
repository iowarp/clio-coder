import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import type { AgentRoleFacts } from "../../src/domains/dispatch/execution-role.js";
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

	it("drops a finished row whose role the rule no longer assigns, never relabels it (row 352)", async () => {
		const runsPath = join(clioStateDir(), "runs.json");
		mkdirSync(clioStateDir(), { recursive: true });
		const base = {
			version: 1,
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
			...measuredRunSpend({ input: 1, output: 1 }, 0),
		};
		const rows = [
			{ ...base, id: "debugger-builder", agentId: "debugger", executionRole: "builder" },
			{ ...base, id: "debugger-checker", agentId: "debugger", executionRole: "checker" },
			{ ...base, id: "coder-builder", agentId: "coder", executionRole: "builder" },
			{ ...base, id: "coder-explorer", agentId: "coder", executionRole: "explorer" },
			{ ...base, id: "scout-builder", agentId: "scout", executionRole: "builder" },
			{ ...base, id: "scout-researcher", agentId: "scout", executionRole: "researcher" },
			{ ...base, id: "verifier-verifier", agentId: "verifier", executionRole: "verifier" },
			{
				...base,
				id: "member-researcher",
				agentId: "scout",
				executionRole: "researcher",
				gate: { role: "member", group: "g", cycle: 1 },
			},
			{
				...base,
				id: "member-seat",
				agentId: "coder",
				executionRole: "seat",
				gate: { role: "member", group: "g", cycle: 1 },
			},
			{ ...base, id: "retry", agentId: "debugger", executionRole: "recovery", lineage: { attempt: 1 } },
			{ ...base, id: "main", agentId: "main-agent", executionRole: "builder" },
			{ ...base, id: "live", agentId: "debugger", executionRole: "builder", endedAt: null, status: "running" },
		];
		writeFileSync(runsPath, JSON.stringify(rows), "utf8");
		const classes: Record<string, string> = { debugger: "verification", coder: "workspace-edit", scout: "read-only" };
		const roleFacts = (agentId: string) => {
			const capabilityClass = classes[agentId];
			return capabilityClass === undefined
				? null
				: { capabilityClass, resultContract: { kind: "text-report" } as AgentRoleFacts["resultContract"] };
		};
		const kept = ["debugger-checker", "coder-builder", "coder-explorer", "member-seat", "retry", "main", "live"];
		const ledger = openLedger({ roleFacts });
		deepStrictEqual(
			ledger
				.list()
				.map((run) => run.id)
				.sort(),
			[...kept].sort(),
		);
		// The write takes the dropped rows out of the file; nothing is relabeled.
		ledger.update("main", { exitCode: 0 });
		await ledger.persist();
		const written = JSON.parse(fs.readFileSync(runsPath, "utf8")) as Array<{ id: string; executionRole: string }>;
		deepStrictEqual(written.map((run) => run.id).sort(), [...kept].sort());
		for (const run of written) strictEqual(run.executionRole, rows.find((row) => row.id === run.id)?.executionRole);
		// A reader with no recipe facts still drops the retired labels and a gate position's wrong role.
		writeFileSync(runsPath, JSON.stringify(rows), "utf8");
		deepStrictEqual(
			openLedger()
				.list()
				.map((run) => run.id)
				.sort(),
			[...kept, "debugger-builder", "scout-builder"].sort(),
		);
	});

	it("merges a persist onto its own last write until another writer replaces runs.json (P3-2)", async () => {
		const runsPath = join(clioStateDir(), "runs.json");
		const input = {
			agentId: "coder",
			executionRole: "builder" as const,
			task: "task",
			targetId: "local",
			wireModelId: "model-a",
			runtimeId: "openai",
			runtimeKind: "http" as const,
			sessionId: null,
			cwd: scratch.dir,
		};
		const original = fs.readFileSync;
		let reads = 0;
		fs.readFileSync = ((...args: Parameters<typeof original>) => {
			if (args[0] === runsPath) reads += 1;
			return original(...args);
		}) as typeof original;
		syncBuiltinESMExports();
		try {
			const mine = openLedger();
			const own = mine.create(input);
			await mine.persist();
			reads = 0;
			mine.update(own.id, { task: "second write" });
			await mine.persist();
			strictEqual(reads, 0, "an unchanged file is not read back");
			const sibling = openLedger();
			const theirs = sibling.create(input);
			await sibling.persist();
			reads = 0;
			mine.update(own.id, { task: "third write" });
			await mine.persist();
			ok(reads > 0, "a file another writer replaced is read back");
			const rows = openLedger().list();
			strictEqual(rows.find((row) => row.id === own.id)?.task, "third write");
			ok(
				rows.some((row) => row.id === theirs.id),
				"the sibling's row survives",
			);
		} finally {
			fs.readFileSync = original;
			syncBuiltinESMExports();
		}
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
