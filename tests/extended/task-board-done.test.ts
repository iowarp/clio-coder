import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createTaskBoardStore,
	foldSessionTaskHistory,
	foldTaskBoard,
	type TaskLedgerEntryFields,
	toTaskLedgerEntryFields,
	unverifiedTaskChecks,
} from "../../src/domains/session/task-board.js";
import { createTasksTool } from "../../src/tools/tasks.js";

const observedAt = "2026-09-24T12:00:00.000Z";
const now = new Date(observedAt);

function ledgerEnvelope(entry: TaskLedgerEntryFields, turnId: string) {
	return { ...entry, turnId, timestamp: observedAt };
}

describe("task board done", () => {
	it("completes a pending task with evidence and records the implicit start", () => {
		const store = createTaskBoardStore({ getSessionId: () => "s1", createBoardId: () => "b1" });
		const planned = store.apply({ op: "plan", title: "issues", tasks: ["fix #12", "fix #15"] });
		ok(planned.ok);
		const done = store.apply({ op: "done", id: "t2", evidence: "node --test tests/compaction.test.ts: 4/4 pass" });
		ok(done.ok, done.ok ? "" : done.message);
		if (!done.ok) return;
		strictEqual(done.board.tasks.find((task) => task.id === "t2")?.status, "completed");
		ok(
			done.notes.some((note) => note.includes("started t2 implicitly")),
			done.notes.join("; "),
		);
	});

	it("still refuses done without evidence", () => {
		const store = createTaskBoardStore({ getSessionId: () => "s1", createBoardId: () => "b1" });
		store.apply({ op: "plan", title: "issues", tasks: ["fix #12"] });
		const done = store.apply({ op: "done", id: "t1", evidence: "  " });
		strictEqual(done.ok, false);
	});

	it("keeps a failed-check completion note without projecting passed validation", async () => {
		const entries: ReturnType<typeof ledgerEnvelope>[] = [];
		const store = createTaskBoardStore({
			getSessionId: () => "s1",
			createBoardId: () => "b1",
			now: () => now,
			readEntries: () => entries,
			appendEntry: (entry) => entries.push(ledgerEnvelope(entry, `ledger-${entries.length}`)),
		});
		ok(store.apply({ op: "plan", title: "validation", tasks: ["run checks"] }).ok);
		const note = "14/16 failed; rerun pending";
		const done = store.apply({ op: "done", id: "t1", evidence: note });
		ok(done.ok, done.ok ? "" : done.message);
		if (!done.ok) return;
		strictEqual(done.board.tasks[0]?.status, "completed");
		strictEqual(done.board.tasks[0]?.evidence, note);
		const written = entries.at(-1);
		ok(written);
		strictEqual(
			written.requiredValidationEvidence.length,
			0,
			"a task note belongs to the completion claim, not a validation row",
		);
		strictEqual(foldTaskBoard(entries)?.tasks[0]?.evidence, note, "the note must remain durable and replayable");
		store.invalidate();
		strictEqual(store.snapshot()?.tasks[0]?.evidence, note);
		const listed = await createTasksTool({ board: store }).run({ action: "list" });
		strictEqual(listed.kind, "ok");
		if (listed.kind === "ok") match(listed.output, /completion claim: 14\/16 failed; rerun pending/);
	});

	it("refolds a legacy passed-note ledger and reprojects the note as a claim", () => {
		const note = "node --test tests/old.test.ts: 4/4 pass";
		const legacy = {
			kind: "taskLedger",
			turnId: "old-ledger",
			parentTurnId: null,
			timestamp: observedAt,
			goals: [{ id: "board", title: "old plan", status: "completed" }],
			subgoals: [{ id: "t1", title: "old task", status: "completed", parentGoalId: "board" }],
			activeRunIds: [],
			requiredValidationEvidence: [{ id: "t1.evidence", description: note, status: "passed", observedAt }],
		};
		const entries: unknown[] = [legacy];
		const written: TaskLedgerEntryFields[] = [];
		const store = createTaskBoardStore({
			getSessionId: () => "s1",
			readEntries: () => entries,
			now: () => now,
			appendEntry: (entry) => {
				written.push(entry);
				entries.push(ledgerEnvelope(entry, `new-ledger-${written.length}`));
			},
		});
		strictEqual(foldTaskBoard(entries)?.tasks[0]?.evidence, note);
		strictEqual(store.snapshot()?.boardId, "legacy");
		strictEqual(store.snapshot()?.tasks[0]?.status, "completed");
		const added = store.apply({ op: "add", tasks: ["follow-up"] });
		ok(added.ok, added.ok ? "" : added.message);
		strictEqual(foldTaskBoard(entries)?.tasks[0]?.evidence, note);
		strictEqual(written.length, 1);
		strictEqual(
			written[0]?.requiredValidationEvidence.length,
			0,
			"resuming an old ledger must not turn its completion note into a fresh validation result",
		);
		strictEqual(legacy.requiredValidationEvidence[0]?.status, "passed", "replay must not rewrite historical entries");
	});

	for (const id of ["t1.evidence", "t1"]) {
		it(`keeps a failed observed check keyed ${id} as validation through replay`, async () => {
			const check = {
				id,
				description: "unit check failed",
				status: "failed" as const,
				command: "unit",
				observedAt,
			};
			const original = ledgerEnvelope(
				{
					kind: "taskLedger",
					parentTurnId: null,
					boardId: "b1",
					goals: [{ id: "board", title: "validation", status: "completed" }],
					subgoals: [{ id: "t1", title: "run unit check", status: "completed", parentGoalId: "board" }],
					activeRunIds: [],
					requiredValidationEvidence: [check],
				},
				"observed-ledger",
			);
			const entries = [original];
			const store = createTaskBoardStore({
				getSessionId: () => "s1",
				readEntries: () => entries,
				now: () => now,
				appendEntry: (entry) => entries.push(ledgerEnvelope(entry, `replayed-ledger-${entries.length}`)),
			});
			const before = store.snapshot()?.tasks[0];
			strictEqual(before?.status, "completed");
			strictEqual(before?.evidence, undefined, "an observed failure must not become a completion claim");
			deepStrictEqual(before?.requiredValidationEvidence, [check]);

			const added = store.apply({ op: "add", tasks: ["follow-up"] });
			ok(added.ok, added.ok ? "" : added.message);
			const projected = entries.at(-1);
			ok(projected);
			deepStrictEqual(projected.requiredValidationEvidence, [check]);
			strictEqual(projected.subgoals[0]?.description, undefined);
			const after = foldTaskBoard(entries)?.tasks[0];
			strictEqual(after?.evidence, undefined);
			deepStrictEqual(after?.requiredValidationEvidence, [check]);
			deepStrictEqual(original.requiredValidationEvidence, [check], "replay must not rewrite the original check");

			const listed = await createTasksTool({ board: store }).run({ action: "list" });
			strictEqual(listed.kind, "ok");
			if (listed.kind === "ok") {
				match(listed.output, /validation result: unit \(failed/);
				doesNotMatch(listed.output, /acceptance(?: requirement)?: unit|completion claim: unit check failed/);
			}
		});
	}

	it("keeps operator declarations and observed checks separate from the done note", async () => {
		const entries: TaskLedgerEntryFields[] = [];
		const store = createTaskBoardStore({
			getSessionId: () => "s1",
			createBoardId: () => "b1",
			now: () => now,
			appendEntry: (entry) => entries.push(entry),
		});
		const picked = store.apply({
			op: "pick",
			title: "validate release",
			userTaskId: "u1",
			verification: [
				{ check: "unit", timeoutMs: 30000 },
				{ check: "integration", timeoutMs: 60000 },
			],
		});
		ok(picked.ok, picked.ok ? "" : picked.message);
		const note = "Implementation done; integration rerun pending";
		const done = store.apply({ op: "done", id: "t1", evidence: note });
		ok(done.ok, done.ok ? "" : done.message);
		if (!done.ok) return;
		const written = entries.at(-1);
		ok(written);
		deepStrictEqual(
			written.requiredValidationEvidence
				.filter((item) => item.id.startsWith("t1.acceptance."))
				.map((item) => [item.command, item.status]),
			[
				["unit", "required"],
				["integration", "required"],
			],
		);
		strictEqual(
			written.requiredValidationEvidence.some((item) => item.status === "passed"),
			false,
		);
		strictEqual(
			written.requiredValidationEvidence.some((item) => item.description === note),
			false,
			"operator requirements and the completion claim must occupy separate fields",
		);
		const replay = foldTaskBoard([ledgerEnvelope(written, "done-ledger")]);
		strictEqual(replay?.tasks[0]?.evidence, note);
		deepStrictEqual(
			replay?.tasks[0]?.requiredValidationEvidence?.map((item) => [item.command, item.status]),
			[
				["unit", "required"],
				["integration", "required"],
			],
		);
		const listed = await createTasksTool({ board: store }).run({ action: "list" });
		strictEqual(listed.kind, "ok");
		if (listed.kind === "ok") {
			match(listed.output, /completion claim: Implementation done; integration rerun pending/);
			match(listed.output, /completion unverified \(required checks no recorded pass: unit, integration\)/);
			match(listed.output, /acceptance requirement: unit .*declaration only/);
		}

		const verified = {
			...done.board,
			tasks: done.board.tasks.map((task) => ({
				...task,
				requiredValidationEvidence:
					task.requiredValidationEvidence?.map((item) =>
						item.command === "unit" ? { ...item, status: "passed" as const, observedAt } : item,
					) ?? [],
			})),
		};
		const withObservedCheck = toTaskLedgerEntryFields(verified, now);
		deepStrictEqual(
			withObservedCheck.requiredValidationEvidence
				.filter((item) => item.id.startsWith("t1.acceptance."))
				.map((item) => [item.command, item.status, item.observedAt]),
			[
				["unit", "passed", observedAt],
				["integration", "required", undefined],
			],
		);
		strictEqual(
			withObservedCheck.requiredValidationEvidence.some((item) => item.status === "passed" && item.description === note),
			false,
			"only the observed check may be passed",
		);
		deepStrictEqual(
			foldTaskBoard([ledgerEnvelope(withObservedCheck, "verified-ledger")])?.tasks[0]?.requiredValidationEvidence?.map(
				(item) => item.status,
			),
			["passed", "required"],
		);
	});

	it("qualifies failed and missing required checks, but not an observed pass", async () => {
		const base = {
			boardId: "b1",
			title: "release",
			activeRunIds: [],
			tasks: [
				{
					id: "t1",
					title: "ship release",
					status: "completed" as const,
					evidence: "Implementation delivered",
					requiredValidationEvidence: [
						{ id: "t1.acceptance.0", description: "unit", command: "unit", status: "failed" as const, observedAt },
						{ id: "t1.acceptance.1", description: "integration", command: "integration", status: "missing" as const },
					],
				},
			],
		};
		const task = base.tasks[0];
		ok(task);
		deepStrictEqual(unverifiedTaskChecks(task), { failed: ["unit"], noRecordedPass: ["integration"] });
		const entries = [ledgerEnvelope(toTaskLedgerEntryFields(base, now), "failed-ledger")];
		const store = createTaskBoardStore({ getSessionId: () => "s1", readEntries: () => entries });
		const listed = await createTasksTool({ board: store }).run({ action: "list" });
		strictEqual(listed.kind, "ok");
		if (listed.kind === "ok")
			match(listed.output, /completion unverified \(required checks failed: unit; no recorded pass: integration\)/);
		const passed = {
			...task,
			requiredValidationEvidence: task.requiredValidationEvidence.map((item) => ({
				...item,
				status: "passed" as const,
				observedAt,
			})),
		};
		strictEqual(unverifiedTaskChecks(passed), null);
		const unobserved = { id: "t1.acceptance.0", description: "unit", command: "unit", status: "passed" as const };
		strictEqual(
			unverifiedTaskChecks({
				...passed,
				requiredValidationEvidence: [unobserved],
			})?.noRecordedPass[0],
			"unit",
		);
	});

	it("keeps the original claim beside an operator-linked repeat in history", () => {
		const original = {
			boardId: "original",
			title: "first delivery",
			activeRunIds: [],
			tasks: [
				{
					id: "t3",
					title: "headless API",
					status: "completed" as const,
					origin: "agent" as const,
					evidence: "14/16 failed; repeat requested",
					requiredValidationEvidence: [
						{ id: "t3.acceptance.0", description: "headless", command: "headless", status: "failed" as const, observedAt },
					],
				},
			],
		};
		const entries: ReturnType<typeof ledgerEnvelope>[] = [
			ledgerEnvelope(toTaskLedgerEntryFields(original, now), "original-ledger"),
		];
		const store = createTaskBoardStore({
			getSessionId: () => "s1",
			readEntries: () => entries,
			createBoardId: () => "repeat",
			appendEntry: (entry) => entries.push(ledgerEnvelope(entry, `repeat-ledger-${entries.length}`)),
		});
		ok(
			store.apply({
				op: "pick",
				title: "repeat headless API",
				userTaskId: "u1",
				verification: [{ check: "headless", timeoutMs: 30000 }],
			}).ok,
		);
		ok(store.apply({ op: "done", id: "t4", evidence: "16/16 claimed" }).ok);
		ok(store.apply({ op: "plan", title: "next board", tasks: ["new work"] }).ok);
		const history = foldSessionTaskHistory(entries);
		strictEqual(history.length, 2);
		strictEqual(history[1]?.tasks.find((task) => task.userTaskId === "u1")?.evidence, "16/16 claimed");
		const first = history[1]?.tasks.find((task) => task.id === "t3");
		strictEqual(first?.evidence, "14/16 failed; repeat requested");
		deepStrictEqual(first && unverifiedTaskChecks(first), { failed: ["headless"], noRecordedPass: [] });
		deepStrictEqual(store.historySnapshot(), history);
	});
});
