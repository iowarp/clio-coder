import assert from "node:assert/strict";
import { test } from "node:test";
import {
	pressRestore,
	REWIND_EMPTY,
	REWIND_RESUME,
	REWIND_RUNNING,
	REWIND_UNAVAILABLE,
	restoreBlocked,
	restoreButton,
	rewindEmpty,
	rewindUnavailable,
	snapshotDiffers,
	snapshotTurn,
	snapshotWhy,
} from "../client/chat/rewind-model.js";

test("an empty snapshot list reads as the empty-state sentence", () => {
	assert.equal(rewindEmpty([]), REWIND_EMPTY);
	assert.equal(rewindEmpty([{ n: 1, at: "2026-01-01T00:00:00Z", reason: "turn-start", differs: 0, skipped: 0 }]), null);
});

test("restore is refused while a turn runs or an approval waits, and the dialog needs an open task", () => {
	assert.equal(restoreBlocked({ running: true, approvalPending: false }), REWIND_RUNNING);
	assert.notEqual(restoreBlocked({ running: false, approvalPending: true }), null);
	assert.equal(restoreBlocked({ running: false, approvalPending: false }), null);
	assert.deepEqual(pressRestore("armed", true), { next: "idle", run: false });
	assert.equal(rewindUnavailable("parked", undefined), REWIND_RESUME);
	assert.equal(rewindUnavailable("open", false), REWIND_UNAVAILABLE);
	assert.equal(rewindUnavailable("open", true), null);
});

test("restoring takes two presses", () => {
	assert.equal(restoreButton("idle"), "Restore files");
	const first = pressRestore("idle", false);
	assert.deepEqual(first, { next: "armed", run: false });
	assert.equal(restoreButton(first.next), "Confirm restore");
	assert.deepEqual(pressRestore(first.next, false), { next: "idle", run: true });
});

test("snapshot rows say why, how much differs and which turn", () => {
	assert.equal(snapshotWhy({ reason: "destructive", tool: "bash" }), "Before a destructive command · bash");
	assert.equal(snapshotWhy({ reason: "turn-start", tool: "store" }), "Before a turn changed files");
	assert.equal(snapshotWhy({ reason: "something-new" }), "something-new");
	assert.equal(snapshotDiffers(0), "Matches the current files");
	assert.equal(snapshotDiffers(3), "3 files differ from now");
	assert.equal(snapshotDiffers(null), null);
	assert.deepEqual(snapshotTurn([{ id: "a" }, { id: "b" }], "b"), { turnId: "b", label: "Turn 2" });
	assert.equal(snapshotTurn([{ id: "a" }], "z"), null);
});
