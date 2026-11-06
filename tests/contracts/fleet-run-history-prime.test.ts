import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { primeDurableWorkerRuns, readDurableWorkerRuns } from "../../src/interactive/fleet-run-history.js";
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

test("primed worker history is read a loop turn per run and taken once by the matching read", async () => {
	const home = await isolateClioEnv("clio-fleet-run-history-prime-");
	try {
		const project = join(home.dir, "project");
		const other = join(home.dir, "other");
		mkdirSync(project);
		mkdirSync(other);
		for (const agent of ["a", "b", "c"]) await settledRun(project, agent);
		const fresh = readDurableWorkerRuns(project);
		strictEqual(fresh.length, 3);

		let turns = 0;
		await primeDurableWorkerRuns(project, undefined, async () => {
			turns += 1;
		});
		strictEqual(turns, 3);
		// A run settled after priming is not in the primed rows, which shows the read took them instead of the ledger.
		await settledRun(project, "d");
		deepStrictEqual(ids(readDurableWorkerRuns(project)), ids(fresh));
		strictEqual(readDurableWorkerRuns(project).length, 4);

		// A read for another project or worktree root never takes rows primed for this one, and discards them.
		await primeDurableWorkerRuns(project, undefined, async () => {});
		strictEqual(readDurableWorkerRuns(other).length, 0);
		await primeDurableWorkerRuns(project, undefined, async () => {});
		strictEqual(readDurableWorkerRuns(project, join(home.dir, "worktrees")).length, 4);
		await settledRun(project, "e");
		strictEqual(readDurableWorkerRuns(project).length, 5);

		// A stop during priming reads no further run and leaves nothing primed.
		const stop = new AbortController();
		let stoppedTurns = 0;
		await primeDurableWorkerRuns(
			project,
			undefined,
			async () => {
				stoppedTurns += 1;
				stop.abort();
			},
			stop.signal,
		);
		strictEqual(stoppedTurns, 1);
		await settledRun(project, "f");
		strictEqual(readDurableWorkerRuns(project).length, 6);

		// An already stopped boot primes nothing even when there is nothing to read.
		const stopped = new AbortController();
		stopped.abort();
		await primeDurableWorkerRuns(other, undefined, async () => {}, stopped.signal);
		await settledRun(other, "g");
		strictEqual(readDurableWorkerRuns(other).length, 1);
	} finally {
		home.restore();
	}
});
