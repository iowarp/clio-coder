import assert from "node:assert/strict";
import { test } from "node:test";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { buildRecallFields, recallErrorMessage, resolveRecall } from "../../src/domains/context/working-set/recall.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";

let clock = 0;
function stamp(): string {
	clock += 1;
	return new Date(1_700_000_000_000 + clock * 1000).toISOString();
}

function user(turnId: string, parentTurnId: string | null, text = turnId): SessionEntry {
	return { kind: "message", turnId, parentTurnId, timestamp: stamp(), role: "user", payload: { text } };
}

function assistant(turnId: string, parentTurnId: string): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		role: "assistant",
		payload: {
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "ok" },
			],
		},
	};
}

/** The shape `turn-persistence.ts` writes for a tool_result turn. */
function toolResult(
	turnId: string,
	parentTurnId: string,
	text: string,
	details?: Record<string, unknown>,
): MessageEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		role: "tool_result",
		payload: {
			toolCallId: `call-${turnId}`,
			toolName: "read",
			result: {
				content: [{ type: "text", text }],
				details: { resultSize: { bytes: text.length, shownBytes: text.length, truncated: false }, ...(details ?? {}) },
			},
			isError: false,
			resultSummary: { bytes: text.length, truncated: false },
		},
	};
}

function eviction(turnId: string, parentTurnId: string, refs: string[]): SessionEntry {
	return {
		kind: "contextEviction",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		policyId: "age-horizon",
		trigger: "pressure",
		evicted: refs.map((entry) => ({
			ref: { entry },
			reason: "age_horizon",
			tokensFreed: 100,
			marker: `[evicted ref=${entry}]`,
		})),
		tokensBefore: 1000,
		tokensAfter: 900,
		pressureBefore: 0.85,
		snapshotIdBefore: null,
	};
}

// Multi-line, trailing whitespace, tabs, non-ASCII, and a CRLF: everything a
// lossy reader would normalize away.
const BODY = "line one  \n\tindented line two\r\nüñîçødé — 日本語\n\n   \nend without newline";

function fixture(): SessionEntry[] {
	return [
		user("u1", null),
		assistant("a1", "u1"),
		toolResult("t1", "a1", BODY),
		toolResult("t2", "t1", "second body"),
		user("u2", "t2"),
		eviction("e1", "u2", ["t1", "t2"]),
	];
}

test("recall: round-trips the original tool_result body byte-exact", () => {
	const entries = fixture();
	const view = foldWorkingSet(entries);
	const outcome = resolveRecall(entries, view, "t1");
	assert.ok(outcome.ok);
	assert.equal(outcome.result.body, BODY);
	assert.equal(Buffer.from(outcome.result.body, "utf8").equals(Buffer.from(BODY, "utf8")), true);
	assert.equal(outcome.result.entry.turnId, "t1");
	assert.deepEqual(outcome.result.ref, { entry: "t1" });
	assert.equal(outcome.result.tokens, Math.ceil(BODY.length / 4));
	assert.equal(outcome.result.offloadPath, undefined);
});

test("recall: buildRecallFields carries trigger, tokens, and the tool call id", () => {
	const entries = fixture();
	const outcome = resolveRecall(entries, foldWorkingSet(entries), "t2");
	assert.ok(outcome.ok);
	assert.deepEqual(buildRecallFields(outcome.result, { trigger: "tool", toolCallId: "call-9" }), {
		kind: "contextRecall",
		ref: { entry: "t2" },
		trigger: "tool",
		tokensReadmitted: Math.ceil("second body".length / 4),
		toolCallId: "call-9",
	});
	const operator = buildRecallFields(outcome.result, { trigger: "operator" });
	assert.equal(operator.trigger, "operator");
	assert.equal("toolCallId" in operator, false);
});

test("recall: a recalled ref stays evicted; a second recall succeeds and counts as churn", () => {
	const entries = fixture();
	const outcome = resolveRecall(entries, foldWorkingSet(entries), "t1");
	assert.ok(outcome.ok);
	const fields = buildRecallFields(outcome.result, { trigger: "tool", toolCallId: "c" });
	const next: SessionEntry[] = [...entries, { ...fields, turnId: "r1", parentTurnId: "u2", timestamp: stamp() }];
	const view = foldWorkingSet(next);
	assert.deepEqual([...view.evicted.keys()], ["t1", "t2"]);
	assert.equal(view.recalls, 1);
	const again = resolveRecall(next, view, "t1");
	assert.ok(again.ok);
	assert.equal(again.result.body, outcome.result.body);
});

test("recall: invalid refs", () => {
	const entries = fixture();
	const view = foldWorkingSet(entries);
	for (const bad of ["", "   ", "t1 t2", "t\n1"]) {
		const outcome = resolveRecall(entries, view, bad);
		assert.ok(!outcome.ok);
		assert.equal(outcome.error.kind, "invalid_ref");
		assert.equal(outcome.error.ref, bad);
	}
	const outcome = resolveRecall(entries, view, "t1 t2");
	assert.ok(!outcome.ok);
	assert.match(recallErrorMessage(outcome.error), /single turnId/);
});

test("recall: not_evicted lists the refs that are evicted", () => {
	const entries = [
		user("u1", null),
		toolResult("turn-a1", "u1", "a"),
		toolResult("turn-a2", "turn-a1", "b"),
		toolResult("turn-b1", "turn-a2", "c"),
		eviction("e1", "turn-b1", ["turn-a1", "turn-a2"]),
	];
	const view = foldWorkingSet(entries);
	const outcome = resolveRecall(entries, view, "turn-b1");
	assert.ok(!outcome.ok);
	assert.deepEqual(outcome.error, { kind: "not_evicted", ref: "turn-b1" });
	assert.match(
		recallErrorMessage(outcome.error, entries, view),
		/not evicted.*Recallable refs on the active path: turn-a1, turn-a2\.$/,
	);

	const unknown = resolveRecall(entries, view, "turn-a2x");
	assert.ok(!unknown.ok);
	assert.equal(unknown.error.kind, "not_on_active_path");
	assert.match(
		recallErrorMessage(unknown.error, entries, view),
		/Recallable refs on the active path: turn-a1, turn-a2\.$/,
	);
});

test("recall: not_on_active_path for an unknown ref says when nothing is evicted", () => {
	const entries = fixture().filter((entry) => entry.kind !== "contextEviction");
	const view = foldWorkingSet(entries);
	const outcome = resolveRecall(entries, view, "zzz");
	assert.ok(!outcome.ok);
	assert.deepEqual(outcome.error, { kind: "not_on_active_path", ref: "zzz" });
	assert.match(recallErrorMessage(outcome.error, entries, view), /not on the active path.*No recallable refs/);
});

test("recall: the listing names tool results only, never evicted thinking", () => {
	const entries: SessionEntry[] = [
		user("u1", null),
		assistant("a1", "u1"),
		toolResult("t1", "a1", "body"),
		user("u2", "t1"),
		eviction("e1", "u2", ["a1", "t1"]),
	];
	const view = foldWorkingSet(entries);
	assert.deepEqual([...view.evicted.keys()], ["a1", "t1"]);
	const outcome = resolveRecall(entries, view, "nope");
	assert.ok(!outcome.ok);
	assert.match(recallErrorMessage(outcome.error, entries, view), /Recallable refs on the active path: t1\.$/);
});

test("recall: the listing is cut after eight refs", () => {
	const refs = Array.from({ length: 10 }, (_, index) => `t${index}`);
	const entries: SessionEntry[] = [user("u1", null)];
	let parent = "u1";
	for (const ref of refs) {
		entries.push(toolResult(ref, parent, `body ${ref}`));
		parent = ref;
	}
	entries.push(eviction("e1", parent, refs));
	const view = foldWorkingSet(entries);
	const outcome = resolveRecall(entries, view, "nope");
	assert.ok(!outcome.ok);
	assert.match(recallErrorMessage(outcome.error, entries, view), /t0, t1, t2, t3, t4, t5, t6, t7, and 2 more\.$/);
});

test("recall: a ref on an abandoned branch is not_on_active_path after a fork", () => {
	// u1 -> t1 (evicted, then abandoned) ; u1 -> t1b (live branch) -> e2 evicts t1b.
	const entries: SessionEntry[] = [
		user("u1", null),
		toolResult("t1", "u1", "abandoned body"),
		eviction("e1", "t1", ["t1"]),
		toolResult("t1b", "u1", "live body"),
		user("u2", "t1b"),
		eviction("e2", "u2", ["t1b"]),
	];
	const view = foldWorkingSet(entries, "u2");
	assert.deepEqual([...view.evicted.keys()], ["t1b"]);
	const abandoned = resolveRecall(entries, view, "t1", "u2");
	assert.ok(!abandoned.ok);
	assert.deepEqual(abandoned.error, { kind: "not_on_active_path", ref: "t1" });
	const live = resolveRecall(entries, view, "t1b", "u2");
	assert.ok(live.ok);
	assert.equal(live.result.body, "live body");

	// Pinning the leaf back onto the abandoned branch flips both answers.
	const other = foldWorkingSet(entries, "t1");
	const nowLive = resolveRecall(entries, other, "t1", "t1");
	assert.ok(nowLive.ok);
	assert.equal(nowLive.result.body, "abandoned body");
	const nowAbandoned = resolveRecall(entries, other, "t1b", "t1");
	assert.ok(!nowAbandoned.ok);
	assert.equal(nowAbandoned.error.kind, "not_on_active_path");
});

test("recall: an offloaded result returns the pointer path, never the file", () => {
	const shown = "first 16KB of output…\n\n[read: 400/1200 lines shown | full: /state/scratch/s/c.txt]";
	const entries: SessionEntry[] = [
		user("u1", null),
		toolResult("t1", "u1", shown, {
			resultSize: { bytes: 99_999, shownBytes: shown.length, truncated: true, offloadPath: "/state/scratch/s/c.txt" },
		}),
		toolResult("t2", "t1", "obs", {
			observation: { tool: "grep", truncated: true, offloadPath: "/state/scratch/s/d.txt" },
		}),
		user("u2", "t2"),
		eviction("e1", "u2", ["t1", "t2"]),
	];
	const view = foldWorkingSet(entries);
	const fromResultSize = resolveRecall(entries, view, "t1");
	assert.ok(fromResultSize.ok);
	assert.equal(fromResultSize.result.offloadPath, "/state/scratch/s/c.txt");
	assert.equal(fromResultSize.result.body, shown);
	const fromObservation = resolveRecall(entries, view, "t2");
	assert.ok(fromObservation.ok);
	assert.equal(fromObservation.result.offloadPath, "/state/scratch/s/d.txt");
});

test("recall: an assistant turn is refused with the thinking message", () => {
	const entries = [
		user("u1", null),
		assistant("a1", "u1"),
		toolResult("t1", "a1", "x"),
		eviction("e1", "t1", ["a1", "t1"]),
	];
	const view = foldWorkingSet(entries);
	const outcome = resolveRecall(entries, view, "a1");
	assert.ok(!outcome.ok);
	assert.equal(outcome.error.kind, "not_evicted");
	assert.match(recallErrorMessage(outcome.error, entries), /thinking is not recallable/);
});

test("recall: legacy payload shapes read the same fields resultText reads", () => {
	const entries: SessionEntry[] = [
		user("u1", null),
		{
			kind: "message",
			turnId: "t1",
			parentTurnId: "u1",
			timestamp: stamp(),
			role: "tool_result",
			payload: { toolName: "bash", output: "plain output string" },
		},
		{
			kind: "message",
			turnId: "t2",
			parentTurnId: "t1",
			timestamp: stamp(),
			role: "tool_result",
			payload: { result: { text: "text field" } },
		},
		eviction("e1", "t2", ["t1", "t2"]),
	];
	const view = foldWorkingSet(entries);
	const a = resolveRecall(entries, view, "t1");
	assert.ok(a.ok);
	assert.equal(a.result.body, "plain output string");
	const b = resolveRecall(entries, view, "t2");
	assert.ok(b.ok);
	assert.equal(b.result.body, "text field");
});
