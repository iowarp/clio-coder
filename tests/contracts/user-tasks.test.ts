import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createUserTasksStore,
	USER_TASKS_RELATIVE_PATH,
	UserTasksStoreError,
} from "../../src/domains/user-tasks/store.js";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "clio-user-tasks-"));
}

describe("contracts/user-tasks store", () => {
	it("writes atomic versioned snapshots under the ignored project-local home", () => {
		const cwd = scratch();
		const store = createUserTasksStore({
			cwd,
			now: () => new Date("2026-08-19T12:00:00.000Z"),
		});
		strictEqual(store.path, join(cwd, ".clio-coder", "user-tasks.json"));
		strictEqual(USER_TASKS_RELATIVE_PATH, ".clio-coder/user-tasks.json");
		match(readFileSync(".gitignore", "utf8"), /^\.clio-coder\/$/m);
		const task = store.add("  Prepare the release  ");
		strictEqual(task.id, "u1");
		strictEqual(task.title, "Prepare the release");
		deepStrictEqual(store.snapshot(), [task]);

		const file = JSON.parse(readFileSync(store.path, "utf8")) as { version: number; nextId: number };
		strictEqual(file.version, 1);
		strictEqual(file.nextId, 2);
		ok(existsSync(join(cwd, ".clio-coder")));
	});

	it("never reuses ids after tasks are completed or dropped", () => {
		const store = createUserTasksStore({ cwd: scratch() });
		strictEqual(store.add("first").id, "u1");
		strictEqual(store.done("u1").status, "done");
		strictEqual(store.add("second").id, "u2");
		strictEqual(store.drop("u2").status, "dropped");
		strictEqual(store.add("third").id, "u3");
	});

	it("enforces open, handed, done, and dropped status transitions", () => {
		let tick = 0;
		const store = createUserTasksStore({
			cwd: scratch(),
			now: () => new Date(`2026-08-19T12:0${tick++}:00.000Z`),
		});
		const handed = store.hand(store.add("handoff").id, "session-1");
		strictEqual(handed.status, "handed");
		strictEqual(handed.handedSessionId, "session-1");
		strictEqual(store.done(handed.id).status, "done");
		throws(() => store.hand(handed.id), /cannot move to handed/);

		const dropped = store.drop(store.add("discard me").id);
		strictEqual(dropped.status, "dropped");
		throws(() => store.done(dropped.id), /cannot move to done/);
		throws(() => store.drop("u999"), /was not found/);
	});

	it("reports corrupt input and leaves the existing file untouched", () => {
		const cwd = scratch();
		const path = join(cwd, USER_TASKS_RELATIVE_PATH);
		mkdirSync(join(cwd, ".clio-coder"), { recursive: true });
		writeFileSync(path, '{"version":1,"nextId":1,"tasks":[', { encoding: "utf8", flag: "w" });
		const before = readFileSync(path, "utf8");
		const store = createUserTasksStore({ cwd });
		throws(() => store.snapshot(), UserTasksStoreError);
		throws(() => store.add("must not overwrite corruption"), /corrupt JSON/);
		strictEqual(readFileSync(path, "utf8"), before);
	});

	it("surfaces write failures without publishing an in-memory mutation", () => {
		const cwd = scratch();
		const store = createUserTasksStore({
			cwd,
			write: () => {
				throw new Error("disk full");
			},
		});
		throws(() => store.add("cannot persist"), /could not write user tasks file/);
		strictEqual(existsSync(store.path), false);
		deepStrictEqual(store.snapshot(), []);
	});

	it("rejects schema records that could reuse or duplicate monotonic ids", () => {
		const cwd = scratch();
		const path = join(cwd, USER_TASKS_RELATIVE_PATH);
		mkdirSync(join(cwd, ".clio-coder"), { recursive: true });
		const task = {
			id: "u2",
			title: "unsafe",
			status: "open",
			createdAt: "2026-08-19T12:00:00.000Z",
			updatedAt: "2026-08-19T12:00:00.000Z",
		};
		writeFileSync(path, JSON.stringify({ version: 1, nextId: 2, tasks: [task] }));
		throws(() => createUserTasksStore({ cwd }).snapshot(), /nextId would reuse/);
		writeFileSync(path, JSON.stringify({ version: 1, nextId: 3, tasks: [task, task] }));
		throws(() => createUserTasksStore({ cwd }).snapshot(), /duplicate id u2/);
	});

	it("records durable board provenance and reconciles interrupted second writes by user identity", () => {
		const store = createUserTasksStore({ cwd: scratch() });
		const task = store.add("ship it");
		const picked = store.recordPicked(task.id, "session-1", "t4");
		strictEqual(picked.status, "picked");
		strictEqual(picked.boardTaskId, "t4");

		const repairedDone = store.reconcile([{ userTaskId: task.id, boardTaskId: "t4", status: "completed" }], "session-1");
		strictEqual(repairedDone[0]?.status, "done");
	});

	it("lets only the owning session release an orphaned pickup across a restart", () => {
		const cwd = scratch();
		const store = createUserTasksStore({ cwd });
		const task = store.add("operator work");
		store.recordPicked(task.id, "session-1", "t1");

		const restarted = createUserTasksStore({ cwd });
		const foreign = restarted.reconcile([{ userTaskId: "u999", boardTaskId: "t1", status: "active" }], "session-2");
		strictEqual(foreign[0]?.status, "picked");
		strictEqual(foreign[0]?.handedSessionId, "session-1");
		strictEqual(foreign[0]?.boardTaskId, "t1", "a reused display id cannot release another session's link");

		const owner = restarted.reconcile([{ userTaskId: "u999", boardTaskId: "t1", status: "active" }], "session-1");
		strictEqual(owner[0]?.status, "handed");
		strictEqual(owner[0]?.boardTaskId, undefined);
	});
});
