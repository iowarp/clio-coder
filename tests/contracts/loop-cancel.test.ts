import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { JobRecord } from "../../src/core/job-types.js";
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
