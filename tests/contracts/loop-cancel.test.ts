import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { JobRecord } from "../../src/core/job-types.js";
import { normalizeJobSpec } from "../../src/domains/scheduling/job-model.js";
import { createJobTurnIndex } from "../../src/domains/scheduling/job-turns.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { LoopHost } from "../../src/session-control/loop-command.js";
import { parseLoopLine, runLoopCommand } from "../../src/session-control/loop-command.js";

for (const count of [0, 1, 2]) {
	test(`bare /loop cancel resolves only one active loop (${count} active)`, async () => {
		const parsed = parseLoopLine("cancel");
		ok(parsed.ok);
		const invoked: unknown[] = [];
		const notices: string[] = [];
		const jobs = [
			...Array.from({ length: count }, (_, index) => ({ id: `job-${index}`, state: "active" })),
			{ id: "old-job", state: "terminal" },
		] as JobRecord[];
		const host: LoopHost = {
			jobs: {
				list: () => jobs,
				status: () => null,
				subscribe: () => () => {},
				invoke: async (args) => {
					invoked.push(args);
					return { kind: "ok", output: "Canceled" };
				},
			},
			notice: (_level, text) => notices.push(text),
			output: () => {},
			now: () => 0,
		};
		await runLoopCommand(parsed.command, host);
		if (count === 1) {
			deepStrictEqual(invoked, [{ action: "cancel", job_id: "job-0" }]);
		} else {
			strictEqual(invoked.length, 0);
			match(notices.join("\n"), count === 0 ? /No active loop/u : /job id.*\/loop list/u);
		}
	});
}

test("other loop control verbs still require an id and explicit cancellation preserves its id", () => {
	for (const verb of ["pause", "resume", "stop"]) strictEqual(parseLoopLine(verb).ok, false);
	deepStrictEqual(parseLoopLine("cancel chosen"), {
		ok: true,
		command: { kind: "control", action: "cancel", id: "chosen" },
	});
});

test("/loop status words a job's spend from the read model over the turns its ledger origin names", async () => {
	const user = (turnId: string, origin?: string) =>
		({ kind: "message", role: "user", turnId, payload: { text: "t", ...(origin ? { origin } : {}) } }) as SessionEntry;
	let entries: SessionEntry[] = [user("u0"), user("u1", "job j1 e1"), user("u2", "job j2 e1")];
	const turnsOf = createJobTurnIndex(() => entries);
	deepStrictEqual(turnsOf("j1"), ["u1"]);
	// An append is scanned from where the last read stopped; a rewritten ledger is scanned again.
	entries = [...entries, user("u3", "job j1 e2")];
	deepStrictEqual(turnsOf("j1"), ["u1", "u3"]);
	entries = [user("u4", "job j1 e3")];
	deepStrictEqual(turnsOf("j1"), ["u4"]);
	deepStrictEqual(turnsOf("j2"), []);

	const job = {
		id: "j1",
		state: "active",
		reason: null,
		spec: normalizeJobSpec({ intervalMs: 60_000, runner: { kind: "main", prompt: "check" } }, 0),
		starts: 2,
		settled: 2,
		consecutiveFailures: 0,
		pendingReason: null,
		active: null,
		pending: null,
		history: [],
		delivery: null,
		nextDueAt: 60_000,
		cancelRequested: false,
		// The record's running sum of rate and catalog guesses is never the card's cost.
		costUsd: 0.5,
		persistenceError: null,
	} as unknown as JobRecord;
	for (const spend of ["~$0.42", null]) {
		const output: string[] = [];
		await runLoopCommand(
			{ kind: "status", id: "j1" },
			{
				jobs: {
					list: () => [job],
					status: () => job,
					spend: () => spend,
					subscribe: () => () => {},
					invoke: async () => ({ kind: "ok", output: "" }),
				},
				notice: () => {},
				output: (lines) => output.push(...lines),
				now: () => 0,
			},
		);
		deepStrictEqual(
			output.filter((line) => line.startsWith("cost")),
			spend === null ? [] : [`cost ${spend}`],
		);
	}
});
