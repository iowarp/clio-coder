import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { harness } from "./harness/app.js";

/**
 * Forward compatibility and resilience.
 *
 * An unrecognized kind is a newer engine talking to an older app: the frame is
 * logged and dropped, and the turn it arrived in still settles. A malformed
 * frame of a kind this app DOES handle is skipped too, but the task is told
 * once, because continuing past it must not be silent. An engine process that
 * ends on its own parks the task so it resumes from the saved session.
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
	const h = await harness({}, { scenario: "tool", lanes: false });
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

test("a malformed frame of a kind this app does handle is skipped, the turn completes and the task is told", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "malformed-update", lanes: false });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(session.id, "Read the fixture");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	const snapshot = h.supervisor.get(session.id);
	assert.equal(snapshot.turns.at(-1)?.status, "succeeded");
	assert.equal(snapshot.state, "open");
	assert.deepEqual(
		snapshot.telemetry?.notices?.filter((notice) => notice.startsWith("CLIO Coder sent an update")),
		["CLIO Coder sent an update this app could not read; it was skipped. (non-text chunk)"],
	);
});

test("an engine process that ends on its own fails the turn, parks the task and says so", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "crash", lanes: false });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(session.id, "Read the fixture");
	await until(() => h.supervisor.get(session.id).state === "parked");
	const snapshot = h.supervisor.get(session.id),
		turn = snapshot.turns.at(-1);
	assert.equal(turn?.status, "failed");
	assert.equal(turn?.problem?.detail, "The CLIO Coder engine process for this task ended unexpectedly.");
	assert.ok(snapshot.telemetry?.notices?.some((notice) => notice.startsWith("The engine process ended unexpectedly.")));
});

test("a content-less running tool update keeps the last partial output", { timeout: 15000 }, async (t) => {
	const h = await harness({}, { scenario: "tool-progress-no-content", lanes: false });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const partials: Array<string | undefined> = [];
	t.after(
		h.hub.connect(undefined, (event) => {
			if (event.type !== "turn.tool") return;
			const item = event.payload.item;
			if (item.status === "in_progress") partials.push(item.partialOutput);
		}),
	);
	h.supervisor.startTurn(session.id, "Read the fixture");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	assert.deepEqual(partials.slice(-2), ["partial output", "partial output"]);
});
