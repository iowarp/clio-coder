import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { acceptanceFromTaskFlags } from "../../src/cli/tasks.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { createTaskBoardStore, foldTaskBoard } from "../../src/domains/session/task-board.js";
import { activeUserTaskAcceptance } from "../../src/domains/user-tasks/active-acceptance.js";
import { formatUserTaskHandoff } from "../../src/domains/user-tasks/handoff.js";
import { createUserTasksStore } from "../../src/domains/user-tasks/store.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { toolPromptHintsForNames } from "../../src/tools/builtin-tool-catalog.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import { createTasksTool } from "../../src/tools/tasks.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Separate controlled replays of retained scenarios/claude/S6-pass-handed and
// S6-handoff-recovery (#354). These local command checks are not scientific
// battletests or evidence that a live model follows the handoff instructions.
async function fixture(sessionId: string) {
	const scratch = await isolateClioEnv("task-handoff-");
	const previousCwd = process.cwd();
	process.chdir(scratch.dir);
	mkdirSync(".clio-coder", { recursive: true });
	writeFileSync("check.cjs", "console.log('controlled check passed');\n");
	writeFileSync(
		".clio-coder/verifiers.yaml",
		"version: 1\nchecks:\n" +
			["grid-numeric", "grid-perf"]
				.map(
					(id) =>
						`  - id: ${id}\n    description: Controlled fixture\n    command: [node, check.cjs]\n    cwd: .\n    timeoutMs: 30000\n    tags: []\n`,
				)
				.join(""),
	);
	const acceptance = acceptanceFromTaskFlags(
		scratch.dir,
		["battletest-output/validation.txt"],
		["grid-numeric", "grid-perf"],
	);
	ok(acceptance);
	const userTasks = createUserTasksStore({ cwd: scratch.dir });
	userTasks.add("Validate current workspace", undefined, acceptance);
	userTasks.add("Unrelated operator task");
	userTasks.hand("u2");
	const entries: unknown[] = [];
	const sessionPath = join(scratch.dir, `${sessionId}.json`);
	const append = (entry: object) => {
		entries.push({
			timestamp: new Date().toISOString(),
			turnId: `entry-${entries.length}`,
			parentTurnId: null,
			...entry,
		});
		writeFileSync(sessionPath, JSON.stringify(entries));
	};
	const board = createTaskBoardStore({
		getSessionId: () => sessionId,
		createBoardId: () => `board-${sessionId}`,
		readEntries: () => entries,
		appendEntry: append,
	});
	const tasks = createTasksTool({ board, userTasks, getSessionId: () => sessionId });
	async function execute(tool: ToolSpec, args: Record<string, unknown>) {
		const toolCallId = `call-${entries.length}`;
		append({ kind: "message", role: "tool_call", payload: { name: tool.name, toolCallId, args } });
		const result = await tool.run(args);
		append({ kind: "message", role: "tool_result", payload: { toolName: tool.name, toolCallId, result } });
		return result;
	}
	async function work() {
		for (const check of ["grid-numeric", "grid-perf"]) {
			const result = await execute(verifyTool, { check });
			strictEqual(result.kind, "ok");
			strictEqual(result.details?.exitCode, 0);
			strictEqual(result.details?.cwd, scratch.dir);
		}
		strictEqual(
			(await execute(writeTool, { path: "battletest-output/validation.txt", content: "Controlled checks passed.\n" }))
				.kind,
			"ok",
		);
	}
	return {
		scratch,
		acceptance,
		userTasks,
		entries,
		sessionPath,
		board,
		tasks,
		execute,
		work,
		close() {
			process.chdir(previousCwd);
			scratch.restore();
		},
	};
}

it("retains the unpicked failure separately: passing checks and prose do not close a handed task", async (t) => {
	const f = await fixture("controlled-unpicked");
	try {
		f.userTasks.hand("u1");
		await f.work();
		const originalClaim = "The operator task is settled solely on this successful current-workspace check evidence.";
		f.entries.push({ kind: "message", role: "assistant", payload: { text: originalClaim } });
		strictEqual(
			activeUserTaskAcceptance(f.userTasks.snapshot(), f.board.snapshot(), "controlled-unpicked", f.entries),
			undefined,
		);
		strictEqual(f.board.snapshot(), null, "there was no pickup; this is not a typed acceptance rejection");
		const listed = await f.execute(f.tasks, { action: "list" });
		ok(listed.kind === "ok");
		match(listed.output, /u1.*durable status=handed; not completed/);
		// A similarly named self-created board is not the missing durable link.
		await f.execute(f.tasks, { action: "plan", title: "Validation", tasks: ["Validate current workspace"] });
		await f.execute(f.tasks, { action: "done", id: "t1", note: "Controlled checks passed" });
		const durable = createUserTasksStore({ cwd: f.scratch.dir }).get("u1");
		strictEqual(durable?.status, "handed");
		strictEqual(durable.handedSessionId, undefined);
		strictEqual(durable.boardTaskId, undefined);
		strictEqual(f.userTasks.get("u2")?.status, "handed");
		t.diagnostic(JSON.stringify({ result: "original-unpicked", claimSupported: false, durable }));
	} finally {
		f.close();
	}
});

for (const mode of ["headless", "interactive"] as const) {
	it(`${mode} handoff picks only the intended task before work and reports durable completion linkage`, async (t) => {
		const sessionId = `controlled-${mode}`;
		const f = await fixture(sessionId);
		try {
			let prompt = "";
			if (mode === "interactive") {
				const context = {
					userTasks: { hand: (id: string) => f.userTasks.hand(id, sessionId) },
					submitChat: (text: string) => {
						prompt = text;
					},
					notice: (_level: string, message: string) => {
						throw new Error(message);
					},
				} as unknown as SlashCommandContext;
				strictEqual(dispatchSlashCommand(parseSlashCommand("/tasks hand u1"), context), "accepted");
			} else {
				prompt = formatUserTaskHandoff(f.userTasks.hand("u1"));
			}
			match(prompt, /Before working.*action="pick" id="u1"/);
			match(prompt, /If pickup fails.*stop/);
			match(prompt, /proposal-only/);
			match(prompt, /then tasks list/);
			strictEqual(f.board.snapshot(), null, "hand submits guidance; the model must still call pick");
			const picked = await f.execute(f.tasks, { action: "pick", id: "u1" });
			ok(picked.kind === "ok");
			const row = f.board.snapshot()?.tasks.find((task) => task.userTaskId === "u1");
			ok(row);
			const linked = createUserTasksStore({ cwd: f.scratch.dir }).get("u1");
			strictEqual(linked?.status, "picked");
			strictEqual(linked.handedSessionId, sessionId);
			strictEqual(linked.boardTaskId, row.id);
			match(picked.output, /operator task u1: durable status=picked; session=controlled-.*; board task=t1/);
			deepStrictEqual(activeUserTaskAcceptance(f.userTasks.snapshot(), f.board.snapshot(), sessionId, []), f.acceptance);
			await f.execute(f.tasks, { action: "start", id: row.id });
			await f.work();
			const done = await f.execute(f.tasks, {
				action: "done",
				id: row.id,
				note: "Fresh controlled grid-numeric and grid-perf receipts: exit 0",
			});
			ok(done.kind === "ok");
			const listed = await f.execute(f.tasks, { action: "list" });
			ok(listed.kind === "ok");
			match(listed.output, /operator task u1: durable status=done; session=controlled-.*; board task=t1/);
			match(listed.output, /u2.*durable status=handed; not completed/);
			const durable = createUserTasksStore({ cwd: f.scratch.dir }).get("u1");
			strictEqual(durable?.status, "done");
			strictEqual(durable.handedSessionId, sessionId);
			strictEqual(durable.boardTaskId, row.id);
			const replay = foldTaskBoard(JSON.parse(readFileSync(f.sessionPath, "utf8")));
			strictEqual(replay?.tasks[0]?.status, "completed");
			strictEqual(replay.tasks[0]?.userTaskId, "u1");
			strictEqual(replay.tasks.length, 1);
			strictEqual(
				assessFinishContract({
					sessionEntries: f.entries,
					rigor: "high",
					activeAcceptance: f.acceptance,
					workspaceRoot: f.scratch.dir,
				}).reason,
				"validation_evidence",
			);
			t.diagnostic(JSON.stringify({ result: `${mode}-recovery`, durable, boardId: replay.boardId, row: replay.tasks[0] }));
		} finally {
			f.close();
		}
	});
}

it("task guidance requires intended pickup and durable confirmation while preserving proposal scope", () => {
	const tool = createTasksTool({ board: createTaskBoardStore() });
	for (const guidance of [tool.description, JSON.stringify(toolPromptHintsForNames(["tasks"], "session"))]) {
		match(guidance, /pick the intended uN before work/);
		match(guidance, /CLI hand alone does not pick/);
		match(guidance, /same session\/board link/);
		match(guidance, /explicit operator go-ahead/);
	}
});
