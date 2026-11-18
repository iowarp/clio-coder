import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verdictText } from "../../src/cli/fleet-board.js";
import { createBoardSource, loadBoard, type WorkerCard } from "../../src/cli/fleet-board-model.js";
import { fleetInspectionScope } from "../../src/cli/fleet-project-scope.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { gateDecisionsDirectory, stagePendingGateDecision } from "../../src/domains/dispatch/gate-decisions.js";
import { openLedger, writeFleetRun } from "../../src/domains/dispatch/state.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

const cli = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

test("fleet inspection defaults to this project and --all deliberately shows every project", async () => {
	const home = await isolateClioEnv("clio-fleet-inspection-scope-");
	try {
		const projectA = join(home.dir, "project-a");
		const projectB = join(home.dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const ledger = openLedger();
		const create = (cwd: string, agentId: string) =>
			ledger.create({
				agentId,
				executionRole: "builder",
				task: `${agentId} private task`,
				targetId: "local",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd,
			});
		const own = create(projectA, "own-agent");
		const foreign = create(projectB, "foreign-agent");
		ledger.update(own.id, { status: "running", pid: 101, heartbeatAt: own.startedAt });
		ledger.update(foreign.id, { status: "running", pid: 102, heartbeatAt: foreign.startedAt });
		await ledger.persist();
		await writeFleetRun({
			version: 1,
			id: "fleet-foreign-root",
			fleet: "foreign-fleet",
			planHash: "hash",
			stepIds: ["step"],
			planSteps: [],
			vars: {},
			startedAt: new Date().toISOString(),
			endedAt: null,
			resumedFrom: null,
			steps: [
				{
					stepId: "step",
					result: {
						stepId: "step",
						assignmentId: "assignment",
						terminalRunId: foreign.id,
						runDigest: "a".repeat(64),
						output: "",
						succeeded: true,
						integrityValid: true,
					},
				},
			],
		});
		const decisionDir = gateDecisionsDirectory();
		mkdirSync(decisionDir, { recursive: true });
		for (const [label, runId] of [
			["own", own.id],
			["foreign", foreign.id],
		] as const) {
			const pending = stagePendingGateDecision(
				{
					group: `${label}-gate`,
					topology: "review",
					cycle: 1,
					outcome: "pass",
					subjects: [{ runId, digest: "a".repeat(64) }],
					createdAt: new Date().toISOString(),
				},
				{ telemetry: { sessionId: null, runId, agent: { role: "coordinator", id: runId } } },
			);
			if (pending.record.kind !== "decision") throw new Error("expected a decision artifact");
			writeFileSync(join(decisionDir, `${label}.json`), JSON.stringify(pending.record.decision));
		}
		const run = (...args: string[]) =>
			spawnSync(process.execPath, [cli, "fleet", ...args], {
				cwd: projectA,
				env: { ...process.env, CLIO_CODER_INTERACTIVE: "0" },
				encoding: "utf8",
				timeout: 20_000,
			});
		const status = run("status", "--json");
		strictEqual(status.status, 0, status.stderr);
		const statusRows = JSON.parse(status.stdout) as { running: Array<{ runId: string }> };
		strictEqual(
			statusRows.running.some((row) => row.runId === own.id),
			true,
		);
		strictEqual(
			statusRows.running.some((row) => row.runId === foreign.id),
			false,
		);
		const globalStatus = run("status", "--json", "--all");
		strictEqual(globalStatus.status, 0, globalStatus.stderr);
		ok(
			(JSON.parse(globalStatus.stdout) as { running: Array<{ runId: string }> }).running.some(
				(row) => row.runId === foreign.id,
			),
		);
		// fleet inspect --json was removed at the maintainer's decision; it points at its replacements (#434).
		const inspect = run("inspect", "--json");
		strictEqual(inspect.status, 2);
		ok(inspect.stderr.includes("clio-coder fleet status --json"), inspect.stderr);
		ok(inspect.stderr.includes("clio-coder telemetry inspect --run <runId> --json"), inspect.stderr);
		const decisions = run("decisions", "--json");
		strictEqual(decisions.status, 0, decisions.stderr);
		const decisionRows = JSON.parse(decisions.stdout) as { decisions: Array<{ subjects: string[] }> };
		ok(decisionRows.decisions.some((row) => row.subjects.includes(own.id)));
		strictEqual(
			decisionRows.decisions.some((row) => row.subjects.includes(foreign.id)),
			false,
		);
		const globalDecisions = run("decisions", "--json", "--all");
		strictEqual(globalDecisions.status, 0, globalDecisions.stderr);
		ok(
			(JSON.parse(globalDecisions.stdout) as { decisions: Array<{ subjects: string[] }> }).decisions.some((row) =>
				row.subjects.includes(foreign.id),
			),
		);
		const hiddenRun = run("view", foreign.id);
		strictEqual(hiddenRun.status, 2);
		ok(!hiddenRun.stdout.includes("foreign-agent"));
		const globalRun = run("view", foreign.id, "--all");
		strictEqual(globalRun.status, 0, globalRun.stderr);
		ok(globalRun.stdout.includes("foreign-agent"));
		const hiddenRoot = run("view", "fleet-foreign-root");
		strictEqual(hiddenRoot.status, 2);
		const globalRoot = run("view", "fleet-foreign-root", "--all");
		strictEqual(globalRoot.status, 0, globalRoot.stderr);
	} finally {
		home.restore();
	}
});

test("the workers board builds cards only for live runs and the newest finished ones (P3-1)", async () => {
	const home = await isolateClioEnv("clio-fleet-board-cards-");
	try {
		const ledger = openLedger();
		const create = (task: string) =>
			ledger.create({
				agentId: "coder",
				executionRole: "builder",
				task,
				targetId: "local",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd: process.cwd(),
			});
		const live = create("live");
		ledger.update(live.id, { status: "running" });
		const baseMs = Date.parse("2026-11-01T00:00:00.000Z");
		const finished: string[] = [];
		for (let index = 0; index < 30; index += 1) {
			const run = create(`finished ${index}`);
			ledger.update(run.id, {
				status: "completed",
				outcome: "succeeded",
				endedAt: new Date(baseMs + index * 1_000).toISOString(),
			});
			finished.unshift(run.id);
		}
		await ledger.persist();
		const source = createBoardSource(clioStateDir());
		const board = loadBoard(source, null, fleetInspectionScope(true), baseMs + 60_000);
		strictEqual(board.running.length, 1);
		strictEqual(board.finished.map((card) => card.runId).join(), finished.slice(0, 24).join());
		// Each built finished card reads its record and folds its telemetry once; rows past the cap are never read.
		strictEqual(source.records.size, 24);
		strictEqual(source.telemetry.size, 24);
	} finally {
		home.restore();
	}
});

test("the workers board reads a finished run's record again until its seal lands (bt-11)", async () => {
	const home = await isolateClioEnv("clio-fleet-board-seal-");
	try {
		const ledger = openLedger();
		const run = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "seal race",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: process.cwd(),
		});
		const endedAt = new Date();
		ledger.update(run.id, { status: "completed", outcome: "succeeded", endedAt: endedAt.toISOString() });
		await ledger.persist();
		const source = createBoardSource(clioStateDir());
		const seal = (nowMs: number) => loadBoard(source, null, fleetInspectionScope(true), nowMs).finished[0]?.record?.seal;
		// The ledger closed the run before dispatch sealed its record.
		strictEqual(seal(endedAt.getTime()), undefined);
		await writeSettledRun(clioStateDir(), fixtureReceiptDraft({ ...fixtureEnvelope(run.id), sessionId: null }));
		strictEqual(seal(endedAt.getTime() + 500), undefined);
		strictEqual(seal(endedAt.getTime() + 1_500), "sealed");
	} finally {
		home.restore();
	}
});

test("a finished card's row keeps its refusal and seal whole and drops the least important fact first (bt-11)", () => {
	const paint = { fg: (_role: unknown, text: string) => text, dim: (text: string) => text };
	const card = {
		state: "succeeded",
		toolCalls: 4,
		record: { outcome: "succeeded", contract: "pass", seal: "seal unchecked", refused: "2 calls refused" },
	} as unknown as WorkerCard;
	strictEqual(verdictText(paint, card, 80), "✓ succeeded · 2 calls refused · seal unchecked · contract met");
	// The dock's row once ended in `seal unche…` and never named the refusal.
	strictEqual(verdictText(paint, card, 50), "✓ succeeded · 2 calls refused · seal unchecked");
	strictEqual(verdictText(paint, card, 40), "✓ succeeded · 2 calls refused");
	// Only the outcome is ever cut.
	const narrow = verdictText(paint, card, 8);
	ok(narrow.startsWith("✓ succe") && narrow.includes("…"), narrow);
});
