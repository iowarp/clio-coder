import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createTaskBoardStore } from "../../src/domains/session/task-board.js";

describe("task board done", () => {
	it("completes a pending task with evidence and records the implicit start", () => {
		const store = createTaskBoardStore({ getSessionId: () => "s1", createBoardId: () => "b1" });
		const planned = store.apply({ op: "plan", title: "issues", tasks: ["fix #12", "fix #15"] });
		ok(planned.ok);
		const done = store.apply({ op: "done", id: "t2", evidence: "node --test tests/compaction.test.ts: 4/4 pass" });
		ok(done.ok, done.ok ? "" : done.message);
		if (!done.ok) return;
		strictEqual(done.board.tasks.find((task) => task.id === "t2")?.status, "completed");
		ok(done.notes.some((note) => note.includes("started t2 implicitly")), done.notes.join("; "));
	});

	it("still refuses done without evidence", () => {
		const store = createTaskBoardStore({ getSessionId: () => "s1", createBoardId: () => "b1" });
		store.apply({ op: "plan", title: "issues", tasks: ["fix #12"] });
		const done = store.apply({ op: "done", id: "t1", evidence: "  " });
		strictEqual(done.ok, false);
	});
});
