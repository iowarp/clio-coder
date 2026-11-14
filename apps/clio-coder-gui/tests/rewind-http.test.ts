import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Problem } from "../contracts/common.js";
import { SnapshotList, SnapshotOutcome, SnapshotPlan, TranscriptDownload } from "../contracts/rewind.js";
import { harness, json } from "./harness/app.js";

test("snapshot routes read the agent's snapshots and refuse a restore while a turn runs", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	const list = await json(await h.request(`${base}/snapshots`), SnapshotList);
	assert.deepEqual(
		list.snapshots.map((row) => [row.n, row.differs]),
		[
			[2, 2],
			[1, 0],
		],
	);
	const plan = await json(await h.request(`${base}/snapshots/2`), SnapshotPlan);
	assert.equal(plan.kind, "plan");
	assert.equal((await h.request(`${base}/snapshots/0`)).status, 422);
	const { turnId } = h.supervisor.startTurn(session.id, "[stream]");
	const refused = await h.post(`${base}/snapshots/2/restore`, {});
	assert.equal(refused.status, 409);
	assert.equal((await json(refused, Problem)).code, "conflict");
	await h.supervisor.cancel(session.id, turnId);
});

test("snapshot restore returns the outcome and the undo point once the task is idle", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const restored = await h.post(`/api/sessions/${session.id}/snapshots/2/restore`, {});
	assert.equal(restored.status, 200);
	const outcome = await json(restored, SnapshotOutcome);
	assert.equal(outcome.kind, "restored");
	assert.equal(outcome.kind === "restored" ? outcome.undo : null, 3);
});

test("a transcript download carries the export back and leaves nothing in the project", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const response = await h.request(`/api/sessions/${session.id}/transcript?format=markdown`);
	assert.equal(response.status, 200);
	const file = await json(response, TranscriptDownload);
	assert.equal(file.mediaType, "text/markdown");
	assert.match(file.filename, /\.md$/);
	assert.ok(file.text.length > 0);
	const left = await readdir(join(h.home.path, ".clio-coder", "exports")).catch(() => []);
	assert.deepEqual(left, []);
	assert.equal((await h.request(`/api/sessions/${session.id}/transcript?format=pdf`)).status, 422);
});
