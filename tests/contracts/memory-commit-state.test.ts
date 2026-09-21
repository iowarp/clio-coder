import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import {
	type MemoryCommitScope,
	MemoryCommitState,
	type SuccessfulMemoryContextCommit,
} from "../../src/domains/memory/commit-state.js";
import type { MemoryRestorationInput } from "../../src/domains/memory/restoration.js";

const scope: MemoryCommitScope = { sessionId: "session-a", branchAnchorTurnId: "branch-a" };
const render: MemoryRestorationInput = {
	bank: {
		version: 1,
		status: null,
		knowledge: [],
		procedural: [
			{
				id: "tm-p-source",
				kind: "procedural",
				content: "Inspect the durable receipt before retrying.",
				createdAt: "2026-09-21T00:00:00.000Z",
				lastTouchedAt: "2026-09-21T00:00:00.000Z",
				injectionCount: 0,
			},
		],
	},
	currentState: null,
	maxTokens: 200,
};

function commit(commitId: string, patch: Partial<SuccessfulMemoryContextCommit> = {}): SuccessfulMemoryContextCommit {
	return { ...scope, kind: "continuity", commitId, outcome: "summarized", ...patch };
}

test("successful identity advances once across producer kind and nonconsecutive duplicate A-B-A", () => {
	const state = new MemoryCommitState(scope, 7);
	const before = state.capture();
	strictEqual(state.notifyContextCommitted(commit("A"), 7), "accepted");
	strictEqual(state.isCurrent(before, scope), false);
	strictEqual(state.notifyContextCommitted(commit("A", { kind: "summary" }), 7), "duplicate");
	strictEqual(state.capture().commitEpoch, 1);
	strictEqual(state.notifyContextCommitted(commit("B", { outcome: "continuity_only" }), 7), "accepted");
	strictEqual(state.notifyContextCommitted(commit("A"), 7), "duplicate");
	strictEqual(state.capture().commitEpoch, 2);
	strictEqual(state.prepareRestoration({ ...render, scope, generation: 7 })?.commitId, "B");
});

test("conflicting duplicate evidence cannot change pending restoration or epoch", () => {
	const state = new MemoryCommitState(scope, 0);
	state.notifyContextCommitted(commit("A"), 0);
	const offer = state.prepareRestoration({ ...render, scope, generation: 0 });
	ok(offer);
	strictEqual(state.notifyContextCommitted(commit("A", { outcome: "evicted" }), 0), "conflict");
	strictEqual(state.notifyContextCommitted(commit("A", { branchAnchorTurnId: "other" }), 0), "conflict");
	strictEqual(state.capture().commitEpoch, 1);
	strictEqual(state.acknowledgeRestoration(offer, scope, 0), true);
});

test("new commit revokes old offers and only exact current issued offer can consume pending state", () => {
	const state = new MemoryCommitState(scope, 0);
	state.notifyContextCommitted(commit("A"), 0);
	const old = state.prepareRestoration({ ...render, scope, generation: 0 });
	ok(old);
	state.notifyContextCommitted(commit("B"), 0);
	strictEqual(state.acknowledgeRestoration(old, scope, 0), false);
	const current = state.prepareRestoration({ ...render, scope, generation: 0 });
	ok(current);
	strictEqual(
		state.acknowledgeRestoration({ ...current }, scope, 0),
		false,
		"copied objects are not issued capabilities",
	);
	strictEqual(state.acknowledgeRestoration(current, scope, 0), true);
	strictEqual(state.acknowledgeRestoration(current, scope, 0), false);
	strictEqual(state.prepareRestoration({ ...render, scope, generation: 0 }), null);
	strictEqual(state.notifyContextCommitted(commit("B", { kind: "summary" }), 0), "duplicate");
	strictEqual(state.prepareRestoration({ ...render, scope, generation: 0 }), null);
});

test("replacement planning keeps stable bytes but revokes the previous issued offer", () => {
	const state = new MemoryCommitState(scope, 0);
	state.notifyContextCommitted(commit("A"), 0);
	const first = state.prepareRestoration({ ...render, scope, generation: 0 });
	ok(first);
	const second = state.prepareRestoration({ ...render, scope, generation: 0 });
	ok(second);
	notStrictEqual(first, second);
	strictEqual(first.message, second.message);
	strictEqual(state.acknowledgeRestoration(first, scope, 0), false);
	strictEqual(state.acknowledgeRestoration(second, scope, 0), true);
});

test("cancellation requires a newer generation, revokes content and offers, and preserves pending commit", () => {
	const state = new MemoryCommitState(scope, 4);
	state.notifyContextCommitted(commit("A"), 4);
	const stamp = state.capture();
	const offer = state.prepareRestoration({ ...render, scope, generation: 4 });
	ok(offer);
	strictEqual(state.cancel(5), true);
	strictEqual(state.capture().commitEpoch, 1);
	strictEqual(state.isCurrent(stamp, scope), false);
	strictEqual(state.acknowledgeRestoration(offer, scope, 5), false);
	strictEqual(state.prepareRestoration({ ...render, scope, generation: 4 }), null);
	strictEqual(state.notifyContextCommitted(commit("B"), 4), "stale");
	const replanned = state.prepareRestoration({ ...render, scope, generation: 5 });
	ok(replanned);
	strictEqual(replanned.commitId, "A");
	for (const generation of [4, 5, -1, Number.NaN, Number.POSITIVE_INFINITY, 5.5])
		strictEqual(state.cancel(generation), false);
	strictEqual(state.acknowledgeRestoration(replanned, scope, 5), true);
});

test("navigation clears pending identities and prevents old scope/generation from regaining authority", () => {
	const state = new MemoryCommitState(scope, 1);
	state.notifyContextCommitted(commit("A"), 1);
	const old = state.prepareRestoration({ ...render, scope, generation: 1 });
	ok(old);
	const nextScope = { sessionId: "session-b", branchAnchorTurnId: null };
	strictEqual(state.reset(nextScope, 1), false);
	strictEqual(state.reset(nextScope, 2), true);
	strictEqual(state.prepareRestoration({ ...render, scope: nextScope, generation: 2 }), null);
	strictEqual(state.notifyContextCommitted(commit("B"), 2), "stale");
	strictEqual(state.acknowledgeRestoration(old, scope, 1), false);
	strictEqual(state.reset(scope, 3), true);
	strictEqual(state.notifyContextCommitted(commit("A"), 1), "stale");
	strictEqual(state.notifyContextCommitted(commit("A"), 3), "accepted", "new scope visit has new generation");
	strictEqual(state.capture().commitEpoch, 1);
});

test("scope checks reject sibling branches and acknowledgements from a different generation", () => {
	const state = new MemoryCommitState(scope, 3);
	const sibling = { ...scope, branchAnchorTurnId: "sibling" };
	strictEqual(state.notifyContextCommitted(commit("A", sibling), 3), "stale");
	state.notifyContextCommitted(commit("A"), 3);
	strictEqual(state.prepareRestoration({ ...render, scope: sibling, generation: 3 }), null);
	const offer = state.prepareRestoration({ ...render, scope, generation: 3 });
	ok(offer);
	strictEqual(state.acknowledgeRestoration(offer, sibling, 3), false);
	strictEqual(state.acknowledgeRestoration(offer, scope, 4), false);
	strictEqual(state.acknowledgeRestoration(offer, scope, 3), true);
});

test("empty bounded restoration can be acknowledged once rather than retried forever", () => {
	const state = new MemoryCommitState(scope, 0);
	state.notifyContextCommitted(commit("A"), 0);
	const offer = state.prepareRestoration({ ...render, maxTokens: 1, scope, generation: 0 });
	ok(offer);
	strictEqual(offer.message, "");
	strictEqual(offer.tokens, 0);
	strictEqual(state.acknowledgeRestoration(offer, scope, 0), true);
	strictEqual(state.prepareRestoration({ ...render, scope, generation: 0 }), null);
});

test("issued output and captured scope survive caller mutation and are deeply frozen", () => {
	const callerScope = { ...scope };
	const state = new MemoryCommitState(callerScope, 0);
	callerScope.sessionId = "changed";
	const inputCommit = { ...commit("A") };
	state.notifyContextCommitted(inputCommit, 0);
	inputCommit.commitId = "mutated";
	inputCommit.outcome = "evicted";
	strictEqual(state.notifyContextCommitted(commit("A"), 0), "duplicate");
	const input = structuredClone(render);
	const offer = state.prepareRestoration({ ...input, scope, generation: 0 });
	ok(offer);
	const text = offer.message;
	strictEqual(offer.commitId, "A");
	const mutable = input.bank.procedural[0] as { content: string };
	mutable.content = "changed";
	strictEqual(offer.message, text);
	deepStrictEqual(offer.scope, scope);
	for (const value of [offer, offer.scope, offer.authority, offer.citedEntryIds, offer.omittedEntryIds, state.capture()])
		ok(Object.isFrozen(value));
	throws(() => {
		(offer as { message: string }).message = "changed";
	}, TypeError);
});

test("dispose permanently revokes issued offers, current stamps and future state transitions", () => {
	const state = new MemoryCommitState(scope, 0);
	state.notifyContextCommitted(commit("A"), 0);
	const offer = state.prepareRestoration({ ...render, scope, generation: 0 });
	ok(offer);
	const stamp = state.capture();
	state.dispose();
	state.dispose();
	strictEqual(state.isCurrent(stamp, scope), false);
	strictEqual(state.notifyContextCommitted(commit("B"), 0), "disposed");
	strictEqual(state.prepareRestoration({ ...render, scope, generation: 0 }), null);
	strictEqual(state.acknowledgeRestoration(offer, scope, 0), false);
	strictEqual(state.cancel(1), false);
	strictEqual(state.reset(scope, 1), false);
});

test("constructor and commit identifiers reject unusable identity or generation", () => {
	for (const generation of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])
		throws(() => new MemoryCommitState(scope, generation));
	throws(() => new MemoryCommitState({ ...scope, sessionId: " " }, 0));
	const state = new MemoryCommitState(scope, 0);
	throws(() => state.notifyContextCommitted(commit(" "), 0));
	strictEqual(state.capture().commitEpoch, 0);
});
