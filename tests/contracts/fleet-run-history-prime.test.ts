import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { readDurableWorkerRuns } from "../../src/interactive/fleet-run-history.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function settledRun(cwd: string, agentId: string): Promise<void> {
	const ledger = openLedger();
	const run = ledger.create({
		agentId,
		executionRole: "builder",
		task: `${agentId} task`,
		targetId: "local",
		wireModelId: "model",
		runtimeId: "openai",
		runtimeKind: "http",
		sessionId: null,
		cwd,
	});
	ledger.update(run.id, { status: "completed", endedAt: new Date().toISOString() });
	await ledger.persist();
}

const ids = (rows: ReadonlyArray<{ runId: string }>): string[] => rows.map((row) => row.runId);

test("worker history loads a run per loop turn after the read that asks, and is taken once complete", async () => {
	const home = await isolateClioEnv("clio-fleet-run-history-prime-");
	try {
		const project = join(home.dir, "project");
		const other = join(home.dir, "other");
		mkdirSync(project);
		mkdirSync(other);
		for (const agent of ["a", "b", "c"]) await settledRun(project, agent);

		// The first read reads nothing on the caller's turn; each later turn reads one run, newest first.
		let turns = 0;
		let release: () => void = () => {};
		const turn = () =>
			new Promise<void>((resolve) => {
				turns += 1;
				release = resolve;
			});
		let arrived = 0;
		deepStrictEqual(
			readDurableWorkerRuns(project, undefined, () => (arrived += 1), turn),
			{
				rows: [],
				complete: false,
			},
		);
		release();
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(readDurableWorkerRuns(project).rows.length, 0); // the ledger listing took this turn
		release();
		await new Promise((resolve) => setImmediate(resolve));
		const partial = readDurableWorkerRuns(project);
		deepStrictEqual([partial.rows.length, partial.complete], [1, false]);
		const newest = ids(partial.rows)[0];
		for (let i = 0; i < 2; i += 1) {
			release();
			await new Promise((resolve) => setImmediate(resolve));
		}
		strictEqual(turns, 4);
		strictEqual(arrived, 1);
		const loaded = readDurableWorkerRuns(project);
		deepStrictEqual([loaded.rows.length, loaded.complete, ids(loaded.rows)[0]], [3, true, newest]);

		// Taken once: the next read starts a fresh load that sees a run settled since.
		await settledRun(project, "d");
		strictEqual(readDurableWorkerRuns(project, undefined, undefined, async () => {}).complete, false);
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(readDurableWorkerRuns(project).rows.length, 4);

		// A read for another project or worktree root abandons a load for this one.
		const arrivals: string[] = [];
		readDurableWorkerRuns(
			project,
			undefined,
			() => arrivals.push("project"),
			async () => {},
		);
		readDurableWorkerRuns(
			other,
			undefined,
			() => arrivals.push("other"),
			async () => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		deepStrictEqual(arrivals, ["other"]);
		deepStrictEqual(readDurableWorkerRuns(other), { rows: [], complete: true });
	} finally {
		home.restore();
	}
});
