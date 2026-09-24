import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gateDecisionsDirectory, stagePendingGateDecision } from "../../src/domains/dispatch/gate-decisions.js";
import { openLedger, writeFleetRun } from "../../src/domains/dispatch/state.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

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
						receiptDigest: "a".repeat(64),
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
			const pending = stagePendingGateDecision({
				group: `${label}-gate`,
				topology: "review",
				cycle: 1,
				outcome: "pass",
				subjects: [{ runId, digest: "a".repeat(64) }],
				createdAt: new Date().toISOString(),
			});
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
		const inspect = run("inspect", "--json");
		strictEqual(inspect.status, 0, inspect.stderr);
		const inspectRows = JSON.parse(inspect.stdout) as {
			runs: Array<{ runId: string }>;
			roots: Array<{ rootId: string }>;
		};
		strictEqual(
			inspectRows.runs.some((row) => row.runId === foreign.id),
			false,
		);
		strictEqual(
			inspectRows.roots.some((row) => row.rootId === "fleet-foreign-root"),
			false,
		);
		const globalInspect = run("inspect", "--json", "--all");
		strictEqual(globalInspect.status, 0, globalInspect.stderr);
		ok(
			(JSON.parse(globalInspect.stdout) as { runs: Array<{ runId: string }> }).runs.some(
				(row) => row.runId === foreign.id,
			),
		);
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
