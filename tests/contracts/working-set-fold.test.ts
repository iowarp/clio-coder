import assert from "node:assert/strict";
import { test } from "node:test";
import { foldWorkingSet, parseRefKey, refKey } from "../../src/domains/context/working-set/fold.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";

let clock = 0;
function stamp(): string {
	clock += 1;
	return new Date(1_700_000_000_000 + clock * 1000).toISOString();
}

function message(
	turnId: string,
	parentTurnId: string | null,
	role: "user" | "assistant" | "tool_result",
): SessionEntry {
	return { kind: "message", turnId, parentTurnId, timestamp: stamp(), role, payload: { text: turnId } };
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

function recall(turnId: string, parentTurnId: string, ref: string): SessionEntry {
	return {
		kind: "contextRecall",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		ref: { entry: ref },
		trigger: "tool",
		tokensReadmitted: 100,
	};
}

test("fold: a recall counts churn and leaves the key evicted", () => {
	const entries: SessionEntry[] = [
		message("u1", null, "user"),
		message("a1", "u1", "assistant"),
		message("t1", "a1", "tool_result"),
		message("t2", "t1", "tool_result"),
		eviction("e1", "t2", ["t1", "t2"]),
		recall("r1", "t2", "t1"),
	];
	const view = foldWorkingSet(entries);
	assert.deepEqual([...view.evicted.keys()], ["t1", "t2"]);
	assert.equal(view.evicted.get("t2")?.evictedAtTurnId, "e1");
	assert.equal(view.evictionEvents, 1);
	assert.equal(view.itemsEvicted, 2);
	assert.equal(view.recalls, 1);
	assert.equal(view.lastPolicyId, "age-horizon");
	assert.equal(view.lastEvictionTurnId, "e1");
});

test("fold: a re-eviction after recall points at the newer event", () => {
	const entries: SessionEntry[] = [
		message("u1", null, "user"),
		message("t1", "u1", "tool_result"),
		eviction("e1", "t1", ["t1"]),
		recall("r1", "t1", "t1"),
		eviction("e2", "t1", ["t1"]),
	];
	const view = foldWorkingSet(entries);
	assert.equal(view.evicted.get("t1")?.evictedAtTurnId, "e2");
	assert.equal(view.itemsEvicted, 2);
	assert.equal(view.recalls, 1);
});

test("fold: forks see only evictions on their own active path (#94)", () => {
	const entries: SessionEntry[] = [
		message("u1", null, "user"),
		message("t1", "u1", "tool_result"),
		// branch A evicts t1
		message("u2a", "t1", "user"),
		eviction("e1", "u2a", ["t1"]),
		// branch B, forked from t1, never evicted anything
		message("u2b", "t1", "user"),
	];
	assert.equal(foldWorkingSet(entries, "u2b").evicted.size, 0);
	assert.deepEqual([...foldWorkingSet(entries, "u2a").evicted.keys()], ["t1"]);
	// Without a leaf the latest append wins, which is branch B here.
	assert.equal(foldWorkingSet(entries).evicted.size, 0);
});

test("ref keys: round-trip and reject blanks", () => {
	assert.equal(refKey({ entry: "01J8" }), "01J8");
	assert.deepEqual(parseRefKey("  01J8 "), { entry: "01J8" });
	assert.equal(parseRefKey(""), null);
	assert.equal(parseRefKey("a b"), null);
});
