import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderCard, verdictText } from "../../src/cli/fleet-board.js";
import { createBoardSource, loadBoard, loadTakeover, type WorkerCard } from "../../src/cli/fleet-board-model.js";
import { fleetInspectionScope } from "../../src/cli/fleet-project-scope.js";
import { runFleetStatus } from "../../src/cli/fleet-status.js";
import { clioStateDir } from "../../src/core/xdg.js";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
	resolveToolBudgetEnvelope,
} from "../../src/domains/dispatch/budget-envelope.js";
import { setCapacityDraining } from "../../src/domains/dispatch/capacity-lease.js";
import { gateDecisionsDirectory, stagePendingGateDecision } from "../../src/domains/dispatch/gate-decisions.js";
import { runFeedPath } from "../../src/domains/dispatch/run-feed.js";
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
			planIdentityHash: "hash",
			cwd: "/workspace/project",
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
		// fleet inspect was removed (#434); it is an ordinary unknown subcommand.
		const inspect = run("inspect", "--json");
		strictEqual(inspect.status, 2);
		ok(inspect.stderr.includes("unknown subcommand 'inspect'"), inspect.stderr);
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

test("fleet status answers from its leaf with and without ledger rows (CLI-P11)", async (t) => {
	const home = await isolateClioEnv("clio-fleet-status-leaf-");
	try {
		t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-20T12:00:00.000Z") });
		const leaf = async (args: string[]) => {
			let stdout = "";
			let stderr = "";
			const code = await runFleetStatus(
				args,
				{ write: (chunk: string) => (stdout += chunk) },
				{ write: (chunk: string) => (stderr += chunk) },
			);
			return { code, stdout, stderr };
		};
		deepStrictEqual(await leaf(["--bogus"]), {
			code: 2,
			stdout: "",
			stderr: "clio-coder fleet: status: unknown flag: --bogus\n",
		});
		const header = `dispatch status @ 2026-11-20T12:00:00.000Z (ledger: ${clioStateDir()})\n`;
		const retrying = "retrying: none (retry queue is in-memory and only visible in the owning process)\n";
		const totalsLine = (stdout: string) => {
			const { totals: x } = JSON.parse(stdout) as { totals: Record<string, { display: string }> };
			return `totals: tokens=${x.total?.display} (in=${x.input?.display} out=${x.output?.display}) cost=${x.usd?.display} runtime=${x.elapsed?.display}\n`;
		};
		const empty = await leaf(["--json"]);
		strictEqual(empty.code, 0, empty.stderr);
		const emptyDoc = JSON.parse(empty.stdout) as Record<string, unknown>;
		deepStrictEqual(
			{ ...emptyDoc, totals: undefined },
			{
				generatedAt: "2026-11-20T12:00:00.000Z",
				admission: { state: "open" },
				running: [],
				retrying: [],
				totals: undefined,
			},
		);
		deepStrictEqual(await leaf([]), {
			code: 0,
			stdout: `${header}admission: open\nrunning: none\n${retrying}${totalsLine(empty.stdout)}`,
			stderr: "",
		});
		setCapacityDraining(true);
		const drained = await leaf([]);
		ok(drained.stdout.includes("admission: draining until "), drained.stdout);
		setCapacityDraining(false);
		// A running row with a budget envelope: the leaf folds its journal and prints the envelope lines.
		const budget = resolveToolBudgetEnvelope({
			recipeId: "scout",
			policy: { toolCalls: 18, readReserve: 4, synthesis: true },
			hardCap: 150,
			hasReadTool: true,
			retry: false,
			revision: false,
		});
		const ledger = openLedger();
		const row = ledger.create({
			agentId: "agent",
			executionRole: "builder",
			task: "task",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: process.cwd(),
			budget,
		});
		ledger.update(row.id, { status: "running", pid: process.pid, heartbeatAt: row.startedAt });
		await ledger.persist();
		const rows = await leaf(["--json"]);
		strictEqual(rows.code, 0, rows.stderr);
		const running = (JSON.parse(rows.stdout) as { running: Array<Record<string, unknown>> }).running;
		deepStrictEqual(
			running.map(({ runId, heartbeat, node, budget: envelope }) => ({ runId, heartbeat, node, envelope })),
			[{ runId: row.id, heartbeat: "alive", node: "local", envelope: budget }],
		);
		const text = await leaf([]);
		const first = running[0] as { elapsed: { display: string }; usd: { display: string } };
		deepStrictEqual(text, {
			code: 0,
			stdout: [
				`${header}admission: open\nrunning:\n`,
				`  ${row.id}  agent  node=local  alive  attempt=0 depth=0  ${first.elapsed.display}  ${first.usd.display}\n`,
				`    recipe policy: ${formatBudgetPolicy(budget)}\n`,
				`    requested envelope: ${formatBudgetRequest(budget)}\n`,
				`    effective envelope: ${formatEffectiveBudget(budget)}\n`,
				`    clamp or escalation reason: ${formatBudgetReasons(budget)}\n`,
				retrying,
				totalsLine(rows.stdout),
			].join(""),
			stderr: "",
		});
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

test("the selected dock card spells out a task its header cuts at the 0.34 share (bt-tui dock cut)", () => {
	const paint = { fg: (_role: unknown, text: string) => text, dim: (text: string) => text };
	const task = "Implement slugify in textutil/slug.py and add unit tests for unicode, punctuation and empty input";
	const card = {
		runId: "r1",
		agentId: "coder",
		task,
		state: "running",
		elapsed: "12s",
		phase: "thinking",
		current: null,
		last: null,
		record: null,
		attempt: 0,
		toolCalls: 0,
		target: "local",
		model: "model",
		startedAtMs: 0,
		endedAtMs: null,
	} as unknown as WorkerCard;
	const options = { nameWidth: 5, nowMs: 0, style: "standard" as const };
	// 45 cells is the dock's share of a 132-column terminal.
	const idle = renderCard(paint, card, 45, { ...options, selected: false });
	strictEqual(idle.length, 2, "an unselected card keeps one header row");
	ok(idle[0]?.includes("…"), idle[0]);
	const selected = renderCard(paint, card, 45, { ...options, selected: true });
	ok(selected.every((row) => row.length <= 45));
	const words = selected
		.slice(1, -1)
		.map((row) => row.replace(/^▌\s*/u, "").trim())
		.join(" ");
	strictEqual(words, task);
	ok(!selected[0]?.includes("Implement"), "the header carries no cut copy of the task");
});

test("the workers takeover reads a sealed report in words, never as its JSON (bt-11 dock-detail)", async () => {
	const home = await isolateClioEnv("clio-fleet-board-report-");
	try {
		const ledger = openLedger();
		const run = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "Implement slugify",
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
		const data = {
			mutatedPaths: ["textutil/slug.py"],
			validations: [{ name: "python-unittest", passed: true, evidence: "4 tests, OK" }],
			summary: "Implemented slugify (bash-hidden-content rail).",
		};
		const text = JSON.stringify(data);
		await writeSettledRun(clioStateDir(), {
			...fixtureReceiptDraft({ ...fixtureEnvelope(run.id), sessionId: null }),
			output: {
				state: "final",
				text,
				bytes: Buffer.byteLength(text),
				truncated: false,
				structured: { version: 1, kind: "mutation-report", data },
			},
		});
		// The report streams as prose; its last delta lands after the host accepted it.
		const at = endedAt.toISOString();
		const events = [
			{ kind: "open", runId: run.id, agentId: "coder" },
			{ kind: "event", type: "text", detail: "Done." },
			{ kind: "event", type: "message_end" },
			{ kind: "event", type: "text", detail: text.slice(0, 40) },
			{ kind: "event", type: "clio_coder_helper_result" },
			{ kind: "event", type: "text", detail: text.slice(40) },
			{ kind: "event", type: "message_end" },
		];
		const feed = runFeedPath(run.id, clioStateDir());
		mkdirSync(dirname(feed), { recursive: true });
		writeFileSync(
			feed,
			events.map((event, index) => `${JSON.stringify({ v: 1, seq: index + 1, at, ...event })}\n`).join(""),
		);
		const takeover = loadTakeover(createBoardSource(clioStateDir()), run.id, endedAt.getTime() + 2_000);
		ok(takeover !== null);
		deepStrictEqual(
			takeover.fold.rows.map((row) => [row.kind, row.text]),
			[
				["text", "Done."],
				["note", "result submitted"],
			],
		);
		strictEqual(
			takeover.card.record?.answer,
			"Implemented slugify (bash-hidden-content rail).\nchanged: textutil/slug.py",
		);
	} finally {
		home.restore();
	}
});
