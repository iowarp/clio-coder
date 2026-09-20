import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { harness } from "./harness/app.js";

/**
 * The two halves of forward compatibility, and the line between them.
 *
 * An unrecognized kind is a newer engine talking to an older app: the frame is
 * logged and dropped, and the turn it arrived in still settles. A malformed
 * frame of a kind this app DOES handle is a broken peer, and it still takes the
 * turn down, because continuing there means projecting a shape no contract
 * describes. Tolerance has to stop exactly at that line or it becomes blindness.
 */
async function until(check: () => boolean) {
	for (let index = 0; index < 400; index += 1) {
		if (check()) return;
		await setTimeout(10);
	}
	throw new Error("The session never settled.");
}

test("an unrecognized sessionUpdate kind is dropped, and the turn it arrived in still completes", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "tool" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(session.id, "Read the fixture");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	const snapshot = h.supervisor.get(session.id),
		turn = snapshot.turns.at(-1);
	// The child sent `future_unknown_kind` between the thought and the tool call.
	assert.equal(turn?.status, "succeeded");
	assert.equal(turn?.stopReason, "end_turn");
	assert.equal(turn?.problem, null);
	assert.equal(snapshot.state, "open");
	// Dropped means dropped: no phantom row, and the frames on either side of it
	// still projected, so the drop did not cost the turn any real content.
	assert.ok(snapshot.timeline.some((item) => item.kind === "tool" && item.toolCallId === "read-1"));
	assert.deepEqual(
		snapshot.timeline.filter((item) => item.turnId === turn?.id).map((item) => item.kind),
		["user", "thought", "tool", "text"],
	);
	assert.equal(
		snapshot.timeline
			.filter((item) => item.kind === "text")
			.map((item) => item.text)
			.join(""),
		"Hello from Clio.",
	);
	// The session survived, so it still takes a second turn on the same child.
	h.supervisor.startTurn(session.id, "Again");
	await until(() => h.supervisor.get(session.id).turns.length === 2);
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	assert.equal(h.supervisor.get(session.id).turns.at(-1)?.status, "succeeded");
});

test("a malformed frame of a kind this app does handle still fails the turn loudly", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "malformed-update" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(session.id, "Read the fixture");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	const turn = h.supervisor.get(session.id).turns.at(-1);
	assert.equal(turn?.status, "failed");
	assert.equal(turn?.problem?.type, "urn:clio-coder:problem:upstream_acp");
});
