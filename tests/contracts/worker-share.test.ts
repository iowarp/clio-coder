import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatWorkerShareNote,
	isWorkerShareNote,
	WORKER_SHARE_NOTE_PREFIX,
	WORKER_SHARE_ORIGIN,
} from "../../src/interactive/worker-share.js";

describe("worker share note", () => {
	it("heads the note with the worker, the run, the outcome, and the operator as origin", () => {
		const note = formatWorkerShareNote({ agentId: "coder", runId: "24pce2v7utza", outcome: "succeeded", text: "done" });
		strictEqual(note, "[worker result] coder · run 24pce2v7utza · ok · shared by the operator\ndone");
		strictEqual(WORKER_SHARE_NOTE_PREFIX, "[worker result]");
		strictEqual(WORKER_SHARE_ORIGIN, "shared by the operator");
	});

	it("keeps a non-success outcome word and shares nothing for an empty answer", () => {
		const note = formatWorkerShareNote({ agentId: "coder", runId: "r1", outcome: "failed", text: "boom" });
		strictEqual(note, "[worker result] coder · run r1 · failed · shared by the operator\nboom");
		strictEqual(formatWorkerShareNote({ agentId: "coder", runId: "r1", outcome: "succeeded", text: "  \n" }), null);
	});

	it("recognizes its own note and nothing else as a share", () => {
		const note = formatWorkerShareNote({ agentId: "coder", runId: "r1", outcome: "succeeded", text: "done" });
		ok(note !== null && isWorkerShareNote(note));
		ok(isWorkerShareNote("  [worker result] coder · run r1 · ok · shared by the operator\ndone"));
		ok(!isWorkerShareNote("[worker results] are in"));
		ok(!isWorkerShareNote("please read the [worker result] note above"));
		ok(!isWorkerShareNote(""));
	});
});
