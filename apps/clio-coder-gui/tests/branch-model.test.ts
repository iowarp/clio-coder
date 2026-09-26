import assert from "node:assert/strict";
import { test } from "node:test";
import { branchView } from "../client/chat/branch-model.js";
import type { SessionTree } from "../contracts/branches.js";

type Node = SessionTree["nodes"][number];
const node = (id: string, parentId: string | null, kind: Node["kind"], active: boolean, preview: string | null = id) =>
	({ id, parentId, kind, at: "2026-09-26T09:00:00.000Z", label: null, preview, active, selectable: true }) as Node;

const tree = (nodes: Node[], leafId: string | null): SessionTree => ({
	version: 1,
	sessionId: "s1",
	leafId,
	parentSessionId: null,
	parentTurnId: null,
	nodes,
	truncated: false,
});

test("branches indent only where a turn continues more than once, and tool steps fold into replies", () => {
	const view = branchView(
		tree(
			[
				node("u1", null, "user", true, "Survey the site"),
				node("c1", "u1", "tool_call", true),
				node("r1", "c1", "tool_result", true),
				node("a1", "r1", "assistant", true, "Two samples found"),
				node("u2", "a1", "user", false, "Measure the first"),
				node("a2", "u2", "assistant", false),
				node("u3", "a1", "user", true, "Measure the second"),
				node("a3", "u3", "assistant", true),
				node("k1", "a3", "compaction", true, null),
			],
			"k1",
		),
	);
	assert.deepEqual(
		view.rows.map((row) => [row.id, row.depth, row.word, row.tip]),
		[
			["u1", 0, "Request", false],
			["a1", 0, "Reply", false],
			["u2", 1, "Request", false],
			["a2", 1, "Reply", false],
			["u3", 1, "Request", false],
			["a3", 1, "Reply", true],
			["k1", 1, "Compacted here", false],
		],
	);
	assert.equal(view.foldedSteps, 2);
	assert.equal(view.branchPoints, 1);
	assert.equal(view.rows.find((row) => row.id === "k1")?.selectable, false, "a compaction is not a place to stand");
	assert.equal(view.rows.find((row) => row.id === "k1")?.text, "(no text recorded)");
	assert.equal(view.forkedFrom, null);
});

test("a forked conversation names where it came from, and an empty one has no tip", () => {
	const empty = branchView({ ...tree([], null), parentSessionId: "parent", parentTurnId: "a1", truncated: true });
	assert.deepEqual(empty.rows, []);
	assert.deepEqual(empty.forkedFrom, { sessionId: "parent", turnId: "a1" });
	assert.equal(empty.truncated, true);
});
