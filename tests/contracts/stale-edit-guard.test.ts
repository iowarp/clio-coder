import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createStaleEditGuardRegistration } from "../../src/domains/session/compaction/stale-edit-guard.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";

const cwd = "/work";
const timestamp = "2026-11-07T00:00:00.000Z";
function message(turnId: string, role: MessageEntry["role"], payload: unknown): MessageEntry {
	return { kind: "message", turnId, parentTurnId: null, timestamp, role, payload };
}
function toolTurn(id: string, name: string, args: Record<string, unknown>, details: unknown = {}, isError = false) {
	return [
		message(`a-${id}`, "assistant", { content: [{ type: "toolCall", id, name, arguments: args }] }),
		message(`r-${id}`, "tool_result", {
			toolCallId: id,
			toolName: name,
			result: { content: [{ type: "text", text: "body" }], details },
			isError,
		}),
	];
}
const checkpoint: SessionEntry = {
	kind: "compactionSummary",
	turnId: "c1",
	parentTurnId: null,
	timestamp,
	summary:
		'## Goal\nEdit helpers\n\n<exact-facts source="clio">\nMeasured by Clio.\nread src/a.ts lines=40 sha256=0123456789ab\nresults:\n</exact-facts>',
	firstKeptTurnId: "u2",
	tokensBefore: 1000,
	messagesSummarized: 3,
};
const beforeCut = [message("u1", "user", { text: "read a" }), ...toolTurn("call_old", "read", { path: "src/a.ts" })];
const afterCut = [message("u2", "user", { text: "now edit a" })];

function verdict(entries: SessionEntry[], args: Record<string, unknown> = { path: "src/a.ts", edits: [] }) {
	const guard = createStaleEditGuardRegistration({ readEntries: () => entries, cwd: () => cwd });
	return guard.evaluate({ hook: "before_tool", toolName: "edit", toolArgs: args });
}
const blocked = (entries: SessionEntry[], args?: Record<string, unknown>) => {
	const effects = verdict(entries, args);
	strictEqual(effects.length, 1);
	strictEqual(effects[0]?.kind, "block_tool");
	return effects[0]?.kind === "block_tool" ? effects[0].reason : "";
};

describe("stale-file edit guard", () => {
	it("refuses an edit of a file the checkpoint summarized until it is read again", () => {
		match(blocked([...beforeCut, checkpoint, ...afterCut]), /^re-read src\/a\.ts before editing it/);
		match(blocked([...beforeCut, checkpoint, ...afterCut], { path: "/work/./src/a.ts", edits: [] }), /re-read/);
		const reread = [...beforeCut, checkpoint, ...afterCut, ...toolTurn("call_new", "read", { path: "src/a.ts" })];
		deepStrictEqual(verdict(reread), []);
		const grepped = [
			...beforeCut,
			checkpoint,
			...afterCut,
			...toolTurn("call_g", "grep", { pattern: "x", path: "src/a.ts" }),
		];
		deepStrictEqual(verdict(grepped), []);
		const shown = [
			...beforeCut,
			checkpoint,
			...afterCut,
			...toolTurn("call_s", "bash", { command: "sed -n 1,9p src/a.ts" }),
		];
		deepStrictEqual(verdict(shown), []);
	});

	it("does not count a look the model no longer sees", () => {
		const failed = [
			...beforeCut,
			checkpoint,
			...afterCut,
			...toolTurn("call_new", "read", { path: "src/a.ts" }, {}, true),
		];
		match(blocked(failed), /re-read/);
		const evicted: SessionEntry[] = [
			...beforeCut,
			checkpoint,
			...afterCut,
			...toolTurn("call_new", "read", { path: "src/a.ts" }),
			{
				kind: "contextEviction",
				turnId: "ev1",
				parentTurnId: null,
				timestamp,
				policyId: "test",
				trigger: "pressure",
				evicted: [{ ref: { entry: "r-call_new" }, reason: "age_horizon", tokensFreed: 10, marker: "[evicted]" }],
				tokensBefore: 100,
				tokensAfter: 90,
				pressureBefore: null,
				snapshotIdBefore: null,
			},
		];
		match(blocked(evicted), /re-read/);
	});

	it("accepts a recall of the earlier read and leaves other files and tools alone", () => {
		const recalled = [
			...beforeCut,
			checkpoint,
			...afterCut,
			...toolTurn("call_recall", "context", { scope: "recall", ref: "r-call_old" }, { recall: { ref: "r-call_old" } }),
		];
		deepStrictEqual(verdict(recalled), []);
		deepStrictEqual(verdict([...beforeCut, checkpoint, ...afterCut], { path: "src/b.ts", edits: [] }), []);
		deepStrictEqual(verdict([...beforeCut, ...afterCut]), []);
		const guard = createStaleEditGuardRegistration({
			readEntries: () => [...beforeCut, checkpoint, ...afterCut],
			cwd: () => cwd,
		});
		deepStrictEqual(guard.evaluate({ hook: "before_tool", toolName: "write", toolArgs: { path: "src/a.ts" } }), []);
	});
});
