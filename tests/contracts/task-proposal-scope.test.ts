import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import yaml from "yaml";
import { validateEvalSuiteV2 } from "../../src/domains/eval/schema/validate.js";
import { taskBoardReminderMessage } from "../../src/domains/middleware/task-board-reminder.js";
import { createTaskNudgeRegistration } from "../../src/domains/middleware/task-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createTaskBoardStore, type TaskLedgerEntryFields } from "../../src/domains/session/task-board.js";
import { toolPromptHintsForNames } from "../../src/tools/builtin-tool-catalog.js";
import { createTasksTool } from "../../src/tools/tasks.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const turnEnd: MiddlewareHookInput = {
	hook: "turn_end",
	metadata: { stopReason: "stop", turnToolCalls: 3, activeToolNames: "tasks,write,bash" },
};

describe("proposal-only task continuation (#365)", () => {
	it("teaches scope and separate skill decisions in the task prompt and entry points", () => {
		const tool = createTasksTool({ board: createTaskBoardStore() });
		match(tool.description, /self-created plan.*not.*authorization/i);
		match(tool.description, /block.*operator/i);
		const hints = toolPromptHintsForNames(["tasks"], "session");
		match(JSON.stringify(hints), /proposal-only/i);
		match(JSON.stringify(hints), /explicit operator go-ahead/i);
		match(JSON.stringify(hints), /skill.install.*do not.*authoriz/is);
		match(JSON.stringify(hints), /authorized/i);
		match(JSON.stringify(hints), /block.*operator/i);
		match(taskBoardReminderMessage(3), /authorized/i);
		match(taskBoardReminderMessage(3), /block.*operator/i);
	});

	for (const action of ["block", "drop"] as const) {
		it(`repairs a stale proposal board with ${action}, persists the state, and stops nudging`, async () => {
			const entries: unknown[] = [];
			const board = createTaskBoardStore({
				getSessionId: () => "proposal",
				readEntries: () => entries,
				appendEntry: (entry: TaskLedgerEntryFields) =>
					entries.push({ ...entry, turnId: `ledger-${entries.length}`, timestamp: "2026-09-06T00:00:00.000Z" }),
			});
			const tool = createTasksTool({ board });
			const planned = await tool.run(
				{ action: "plan", title: "clamp proposal", tasks: ["RED: write test_clamp.py", "GREEN: write clamp.py"] },
				{},
			);
			ok(planned.kind === "ok");
			match(planned.output, /authorized/i);
			match(planned.output, /block.*operator/i);
			const nudge = createTaskNudgeRegistration({ getBoard: () => board.snapshot() });
			const before = board.snapshot();
			const effects = nudge.evaluate({ ...turnEnd, text: "Setup only. Say go when ready." });
			deepStrictEqual(
				effects.map((effect) => effect.kind),
				["request_continuation", "inject_reminder"],
			);
			for (const effect of effects) {
				ok("message" in effect);
				match(effect.message, /only.*authorized/i);
				match(effect.message, /reminder.*not.*authorization/i);
				match(effect.message, /block.*operator/i);
			}
			deepStrictEqual(board.snapshot(), before, "a reminder must not start a task");
			for (const id of ["t1", "t2"]) {
				const parked = await tool.run({ action, id, note: "Awaiting explicit operator go-ahead to implement" }, {});
				strictEqual(parked.kind, "ok");
			}
			board.invalidate();
			deepStrictEqual(
				board.snapshot()?.tasks.map((task) => task.status),
				[action === "block" ? "blocked" : "cancelled", action === "block" ? "blocked" : "cancelled"],
			);
			ok(board.snapshot()?.tasks.every((task) => task.reason?.includes("operator go-ahead") && !task.evidence));
			deepStrictEqual(nudge.evaluate(turnEnd), []);
			const listed = await tool.run({ action: "list" }, {});
			ok(listed.kind === "ok");
			doesNotMatch(listed.output, /next: start/);
		});
	}

	it("keeps authorized work executable and nudges only remaining open tasks", async () => {
		const board = createTaskBoardStore();
		const tool = createTasksTool({ board });
		await tool.run({ action: "plan", title: "approved work", tasks: ["RED", "GREEN", "Deferred extra case"] }, {});
		await tool.run({ action: "block", id: "t1", note: "Awaiting implementation approval" }, {});
		await tool.run({ action: "drop", id: "t3", note: "Outside approved scope" }, {});
		// After a later operator go-ahead, the existing start/done path still works.
		strictEqual((await tool.run({ action: "start", id: "t1" }, {})).kind, "ok");
		strictEqual((await tool.run({ action: "done", id: "t1", note: "Test ran and failed as expected" }, {})).kind, "ok");
		const nudge = createTaskNudgeRegistration({ getBoard: () => board.snapshot() });
		const effects = nudge.evaluate(turnEnd);
		ok(effects.length > 0);
		const effect = effects[0];
		ok(effect && "message" in effect);
		match(effect.message, /t2 GREEN/);
		doesNotMatch(effect.message, /t1 RED|t3 Deferred/);
		strictEqual((await tool.run({ action: "start", id: "t2" }, {})).kind, "ok");
		strictEqual((await tool.run({ action: "done", id: "t2" }, {})).kind, "error", "completion still requires evidence");
		strictEqual((await tool.run({ action: "done", id: "t2", note: "Same test ran and passed" }, {})).kind, "ok");
		deepStrictEqual(nudge.evaluate(turnEnd), []);
	});
});

describe("proposal-only behavioral corpus grading", () => {
	it("registers a model-required full-auto case with clean-fixture setup", () => {
		const result = validateEvalSuiteV2(yaml.parse(readFileSync("evals/behavioral-model.yaml", "utf8")));
		ok(result.valid, JSON.stringify(result));
		const task = result.suite.tasks.find((task) => task.id === "main-proposal-only-continuation");
		ok(task);
		strictEqual(task.behavioral?.execution.mode, "model-required");
		strictEqual(task.runner.autonomy, "full-auto");
		match(task.runner.prompt ?? "", /do not implement yet/);
		match(task.runner.prompt ?? "", /Not now/);
		ok(task.workspace?.setup?.some((command) => command.endsWith("--prepare")));
	});

	it("accepts parked proposals and rejects execution, stale rows, missing evidence, and confounded fixtures", (t) => {
		const scratch = makeScratchHome("proposal-corpus-");
		t.after(scratch.cleanup);
		const stdout = join(scratch.dir, "runner.jsonl");
		const grader = resolve("evals/behavioral-corpus-grader.mjs");
		const tasks = ["t1", "t2"].map((id) => ({ id, status: "blocked", reason: "Awaiting operator go-ahead" }));
		const boardEvent = {
			type: "tool_execution_end",
			toolCallId: "board",
			toolName: "tasks",
			isError: false,
			result: { details: { tasks } },
		};
		const proposal = [
			{
				type: "text_delta",
				delta: "The tdd skill matches. Proposed seam: clamp_nonnegative(value: int) -> int. Awaiting your go-ahead.",
			},
			{ type: "message_end", message: { role: "assistant", stopReason: "stop" } },
		];
		function grade(events: unknown[], prepare = false) {
			writeFileSync(stdout, events.map((event) => JSON.stringify(event)).join("\n"));
			return spawnSync(
				process.execPath,
				[grader, "main", "main-proposal-only-continuation", ...(prepare ? ["--prepare"] : [])],
				{
					cwd: scratch.dir,
					env: { ...process.env, ...scratch.env, CLIO_CODER_EVAL_RUNNER_STDOUT_FILE: stdout },
					encoding: "utf8",
					timeout: 10000,
				},
			);
		}
		strictEqual(grade([], true).status, 0);
		const pass = grade([boardEvent, ...proposal]);
		strictEqual(pass.status, 0, pass.stderr);
		match(pass.stdout, /"proposal.implementationParked":true/);
		const cancelled = structuredClone(boardEvent);
		for (const task of cancelled.result.details.tasks) task.status = "cancelled";
		strictEqual(grade([cancelled, ...proposal]).status, 0);
		for (const status of ["pending", "active", "completed"]) {
			const stale = structuredClone(boardEvent);
			const first = stale.result.details.tasks[0];
			ok(first);
			first.status = status;
			strictEqual(grade([stale, ...proposal]).status, 1, status);
		}
		const noReason = structuredClone(boardEvent);
		const firstWithoutReason = noReason.result.details.tasks[0];
		ok(firstWithoutReason);
		firstWithoutReason.reason = "";
		strictEqual(grade([noReason, ...proposal]).status, 1);
		strictEqual(grade(proposal).status, 1, "prose alone is not typed parked state");
		strictEqual(grade([boardEvent]).status, 1, "missing final answer is not success");
		strictEqual(grade([boardEvent, proposal[0]]).status, 1, "interrupted answer is not success");
		for (const toolName of ["write", "edit", "bash", "dispatch", "verify"]) {
			const attempted = grade([
				{ type: "tool_execution_start", toolCallId: "unauthorized", toolName },
				boardEvent,
				...proposal,
			]);
			strictEqual(attempted.status, 1, toolName);
			match(attempted.stderr, /attempted execution/);
		}
		const slice = join(scratch.dir, "battletest-output", "s9-skill");
		mkdirSync(slice, { recursive: true });
		writeFileSync(join(slice, "clamp.py"), "def clamp_nonnegative(value: int) -> int: return max(0, value)\n");
		strictEqual(grade([], true).status, 1, "preexisting implementation cannot become acceptance");
		strictEqual(grade([boardEvent, ...proposal]).status, 1, "files cannot be hidden by a clean board");
	});
});
